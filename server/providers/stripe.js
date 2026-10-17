import Stripe from 'stripe';
import { getSetting } from 'kempo/server/sdk.js';

/*
  The Stripe processor module. Nothing outside this file knows Stripe exists.

  The contract every provider module implements is documented in server/providers/index.js. This is
  the reference implementation of it, and the only one that ships today — the shape is what makes
  adding PayPal or Square a new file here rather than a rewrite everywhere else.

  Two decisions worth stating, because they are the ones somebody would otherwise undo:

  - `automatic_payment_methods` is enabled on every intent. That single flag is what makes Apple
    Pay, Google Pay, Klarna, Afterpay and the rest appear in the payment form for the customers
    whose device and country support them, with no extra integration and no separate merchant
    account. Turning it off to hand-pick payment method types trades all of that away for nothing.

  - No `apiVersion` is pinned. The SDK sends the version it was built and tested against, which is
    the one this code was written for; naming a different one here is how you get a response shape
    the installed SDK does not expect.
*/

export const name = 'stripe';
export const label = 'Stripe';

/*
  Where Stripe should be told to send events, appended to the site's own origin. Shown on the
  settings screen so the value pasted into the Stripe dashboard is not one somebody has to derive.
*/
export const webhookPath = '/payments/api/webhooks/stripe';

/*
  The header its signature arrives in. Declared by the provider rather than assumed by the route,
  because every processor picked a different name for it and the route should not have to know all
  of them to accept one.
*/
export const signatureHeader = 'stripe-signature';

/*
  The events the endpoint needs to be sent, listed so the settings screen can show exactly what to
  tick in the Stripe dashboard rather than leaving somebody to work it out from this file.

  Subscribing to everything would also work and is what "send all events" does, but it fills the
  event log with things this extension deliberately ignores, and the log is the diagnostic — a
  screen of noise is a screen nobody reads when a payment goes missing.
*/
export const webhookEvents = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.canceled',
  'payment_intent.requires_action',
  'payment_intent.amount_capturable_updated',
  'charge.refunded',
  'charge.refund.updated',
  'charge.dispute.created',
  'charge.dispute.closed',
];

/*
  The settings holding this provider's credentials, in the order a settings screen should render
  them. Declared here rather than in the screen so a second provider's fields arrive with it.
  Every name must also exist in kempo-config.json — a static test checks that.
*/
export const credentialFields = [
  {
    name: 'stripe_publishable_key',
    label: 'Publishable key',
    type: 'string',
    placeholder: 'pk_test_…',
    help: 'From Developers → API keys. This one is public — it is embedded in the payment form in every customer’s browser.',
  },
  {
    name: 'stripe_secret_key',
    label: 'Secret key',
    type: 'secret',
    placeholder: 'sk_test_…',
    help: 'From the same screen, revealed once. It can move money, so it is encrypted here and never sent back to a browser.',
  },
  {
    name: 'stripe_webhook_secret',
    label: 'Webhook signing secret',
    type: 'secret',
    placeholder: 'whsec_…',
    help: 'Shown when you add the endpoint below under Developers → Webhooks. Without it every incoming event is rejected, so no payment is ever confirmed.',
  },
];

const credentials = async () => {
  const read = async key => {
    const [error, value] = await getSetting('kempo-payments', key, '');
    return error ? '' : String(value || '');
  };

  const [publishableKey, secretKey, webhookSecret] = await Promise.all([
    read('stripe_publishable_key'),
    read('stripe_secret_key'),
    read('stripe_webhook_secret'),
  ]);

  return { publishableKey, secretKey, webhookSecret };
};

/*
  One client per secret key, kept between requests. Rebuilt the moment the key changes, which is
  what makes rotating a key on the settings screen take effect without a restart.
*/
let cached = { key: null, client: null };

const clientFor = secretKey => {
  if(cached.key !== secretKey){
    cached = { key: secretKey, client: new Stripe(secretKey) };
  }
  return cached.client;
};

const withClient = async () => {
  const { secretKey } = await credentials();
  if(!secretKey) return [{ code: 409, msg: 'Stripe is not connected yet — add a secret key on the payments settings screen' }, null];
  return [null, clientFor(secretKey)];
};

/*
  Two kinds of message come back from Stripe, and only one of them is written for whoever ends up
  reading it.

  A **card error** ("Your card was declined", "Your card has insufficient funds. Try a different
  card.") is written for the person paying, so it passes through whole — replacing it with something
  vaguer would take away the one thing they can act on.

  Everything else is written for the person who set the account up, and can be a good deal more than
  a caller should hand a customer: asking for a currency the account cannot take returns the account's
  entire supported-currency list and a dashboard link — measured at ~1,500 characters. Those are
  logged in full for whoever runs the site, and only the first sentence goes back, capped in length.

  The status code is clamped: a Stripe 402 is meaningful, but its network and rate-limit errors
  should not become a 0 that a caller reads as its own fault.
*/
const MAX_MESSAGE = 200;

export const failure = error => {
  const code = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600
    ? error.statusCode
    : 502;
  const message = error?.message || 'The payment processor rejected the request';

  if(error?.type === 'StripeCardError') return [{ code, msg: message }, null];

  console.warn(`[kempo-payments] Stripe ${error?.type || 'error'}: ${message}`);
  const firstSentence = message.split(/(?<=[.!?])\s/)[0];
  return [{ code, msg: firstSentence.length > MAX_MESSAGE ? `${firstSentence.slice(0, MAX_MESSAGE - 1)}…` : firstSentence }, null];
};

const STATUS_MAP = {
  requires_payment_method: 'requires_payment_method',
  requires_confirmation: 'requires_confirmation',
  requires_action: 'requires_action',
  processing: 'processing',
  requires_capture: 'requires_capture',
  succeeded: 'succeeded',
  canceled: 'canceled',
};

/*
  A Stripe PaymentIntent, in kempo's vocabulary.

  `amountRefunded` only has a real answer when the charge behind the intent has been expanded — an
  unexpanded `latest_charge` is a bare id string. Reporting 0 in that case would overwrite a real
  refund total with a wrong one, so it comes back undefined and the caller keeps what it has.
*/
export const fromIntent = intent => {
  const charge = intent.latest_charge && typeof intent.latest_charge === 'object' ? intent.latest_charge : null;

  return {
    ref: intent.id,
    status: STATUS_MAP[intent.status] || 'processing',
    amount: intent.amount,
    amountCaptured: intent.amount_received ?? 0,
    amountRefunded: charge ? charge.amount_refunded : undefined,
    currency: intent.currency,
    captureMethod: intent.capture_method === 'manual' ? 'manual' : 'automatic',
    livemode: !!intent.livemode,
    lastError: intent.last_payment_error?.message || null,
  };
};

export const status = async () => {
  const { publishableKey, secretKey, webhookSecret } = await credentials();

  /*
    Which mode the keys are for is read off the keys themselves rather than kept as a separate
    toggle. A toggle can disagree with the keys; a prefix cannot, and "the switch says test but the
    key is live" is the one configuration mistake in this extension that costs real money.
  */
  const mode = secretKey.startsWith('sk_live_') ? 'live' : secretKey.startsWith('sk_test_') ? 'test' : null;

  return [null, {
    provider: name,
    label,
    configured: !!(secretKey && publishableKey),
    hasSecretKey: !!secretKey,
    hasPublishableKey: !!publishableKey,
    hasWebhookSecret: !!webhookSecret,
    /*
      Which credentials are set, keyed by setting name — booleans, never values. The settings screen
      renders its fields from `credentialFields` and needs to mark the ones already filled in; going
      through the field's own name means it does that without a table of provider-specific special
      cases that a second provider would have to be added to.
    */
    fields: {
      stripe_publishable_key: !!publishableKey,
      stripe_secret_key: !!secretKey,
      stripe_webhook_secret: !!webhookSecret,
    },
    mode,
    livemode: mode === 'live',
    /*
      Keys from two different modes cannot be used together: an intent created with a test secret
      key has a client secret the live publishable key cannot confirm, and the failure surfaces in
      the browser as a generic error with nothing pointing at the cause.
    */
    mismatchedKeys: !!(secretKey && publishableKey && mode
      && !publishableKey.startsWith(mode === 'live' ? 'pk_live_' : 'pk_test_')),
    webhookPath,
  }];
};

/*
  The options every call about one intent is sent with.

  An intent made on a connected account (a Connect *direct charge*) exists only on that account, so
  every later call has to name it in the `Stripe-Account` header — the SDK's `stripeAccount` option.
  Leaving it off does not fail loudly: Stripe answers "No such payment_intent", for an intent that is
  sitting right there on the other account. So the account always comes from the payment row (see
  server/utils/payments/actions.js) and every call below goes through this one function.

  Returns undefined when there is nothing to send, so an ordinary payment's calls are exactly what
  they were before connected accounts existed.
*/
export const requestOptions = ({ connectedAccount, idempotencyKey } = {}) => {
  const options = {
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(connectedAccount ? { stripeAccount: connectedAccount } : {}),
  };
  return Object.keys(options).length ? options : undefined;
};

/*
  What a browser needs to confirm a payment. For a payment on a connected account that includes the
  account: Stripe.js has to be initialised with `{ stripeAccount }` or it cannot see the intent at
  all — see public/components/PaymentForm.js and its `connected-account` attribute.
*/
export const clientConfig = async ({ connectedAccount } = {}) => {
  const { publishableKey } = await credentials();
  if(!publishableKey) return [{ code: 409, msg: 'Stripe is not connected yet' }, null];
  return [null, { publishableKey, ...(connectedAccount ? { stripeAccount: connectedAccount } : {}) }];
};

export const createIntent = async ({ amount, currency, description, metadata, captureMethod, customerEmail, idempotencyKey, connectedAccount, applicationFee }) => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];

  try {
    const intent = await stripe.paymentIntents.create({
      amount,
      currency,
      /*
        The site's cut of a payment taken on a connected account. Stripe moves it to the platform's
        balance when the charge succeeds and takes its own processing fee from the connected account.
        Zero is not sent: Stripe requires a positive amount, and no fee means no parameter.
      */
      ...(connectedAccount && applicationFee > 0 ? { application_fee_amount: applicationFee } : {}),
      capture_method: captureMethod === 'manual' ? 'manual' : 'automatic',
      description: description || undefined,
      receipt_email: customerEmail || undefined,
      /*
        Stripe metadata values must be strings, and it rejects a key whose value is not one — which
        is how a payment arrives at the dashboard missing the order number somebody was counting on
        being able to search for.
      */
      metadata: Object.fromEntries(
        Object.entries(metadata || {}).map(([key, value]) => [key, String(value)]),
      ),
      automatic_payment_methods: { enabled: true },
    }, requestOptions({ idempotencyKey, connectedAccount }));

    return [null, { ...fromIntent(intent), clientSecret: intent.client_secret }];
  } catch(err) {
    return failure(err);
  }
};

export const retrieveIntent = async (ref, { connectedAccount } = {}) => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];

  try {
    const intent = await stripe.paymentIntents.retrieve(ref, { expand: ['latest_charge'] }, requestOptions({ connectedAccount }));
    return [null, { ...fromIntent(intent), clientSecret: intent.client_secret }];
  } catch(err) {
    return failure(err);
  }
};

export const capture = async (ref, { amount, connectedAccount } = {}) => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];

  try {
    const intent = await stripe.paymentIntents.capture(ref, {
      ...(amount ? { amount_to_capture: amount } : {}),
      expand: ['latest_charge'],
    }, requestOptions({ connectedAccount }));
    return [null, fromIntent(intent)];
  } catch(err) {
    return failure(err);
  }
};

export const cancel = async (ref, { connectedAccount } = {}) => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];

  try {
    const intent = await stripe.paymentIntents.cancel(ref, {}, requestOptions({ connectedAccount }));
    return [null, fromIntent(intent)];
  } catch(err) {
    return failure(err);
  }
};

/*
  Stripe accepts exactly three reasons and rejects anything else outright, so a free-text reason is
  carried as metadata instead of being dropped. The person issuing the refund typed it for somebody
  to read later; losing it because it was not on a list of three is not an acceptable outcome.
*/
const STRIPE_REASONS = new Set(['duplicate', 'fraudulent', 'requested_by_customer']);

/*
  A refund, in kempo's vocabulary. `pending` is a normal answer, not a failure: a refund is not
  instant for every payment method, and the webhook is what eventually says which it became.
*/
const refundFrom = entry => ({
  ref: entry.id,
  amount: entry.amount,
  currency: entry.currency,
  status: entry.status === 'succeeded' ? 'succeeded' : entry.status === 'failed' ? 'failed' : 'pending',
  reason: entry.reason || entry.metadata?.reason || null,
});

/*
  The body of a refund request.

  `refund_application_fee` only exists for a charge on a connected account, and only means something
  there: Stripe's own default is to keep the site's fee and take the whole refund out of the
  connected account's balance. It is sent only when the caller decided either way (see
  `refundOptionsFor` in server/utils/payments/actions.js), so an ordinary refund is the same request
  it always was. With it, Stripe gives back the fee in proportion to the refund — all of it for a full
  refund.
*/
export const refundParams = (ref, { amount, reason, refundApplicationFee } = {}) => ({
  payment_intent: ref,
  ...(amount ? { amount } : {}),
  ...(STRIPE_REASONS.has(reason) ? { reason } : {}),
  ...(reason && !STRIPE_REASONS.has(reason) ? { metadata: { reason: String(reason) } } : {}),
  ...(typeof refundApplicationFee === 'boolean' ? { refund_application_fee: refundApplicationFee } : {}),
});

export const refund = async (ref, { amount, reason, connectedAccount, refundApplicationFee, idempotencyKey } = {}) => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];

  try {
    const created = await stripe.refunds.create(
      refundParams(ref, { amount, reason, refundApplicationFee: connectedAccount ? refundApplicationFee : undefined }),
      requestOptions({ connectedAccount, idempotencyKey }),
    );

    return [null, { ...refundFrom(created), reason: reason || null }];
  } catch(err) {
    return failure(err);
  }
};

/*
  Every refund on a payment, asked of Stripe directly.

  Needed because the `charge.refunded` event no longer carries them: on the current API version it
  reports only the new running total (`amount_refunded`), with no list of which refunds make it up.
  An event that says "100 has been refunded" cannot be turned into a refund row without asking who
  refunded it — found by testing, when a refund reached the webhook and was recorded as nothing.
*/
export const listRefunds = async (ref, { connectedAccount } = {}) => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];

  try {
    const listed = await stripe.refunds.list({ payment_intent: ref, limit: 100 }, requestOptions({ connectedAccount }));
    return [null, listed.data.map(refundFrom)];
  } catch(err) {
    return failure(err);
  }
};

/*
  Disputes (chargebacks), in kempo's vocabulary rather than Stripe's: a status of `needs_response`,
  `under_review`, `won`, `lost` or `closed`. Stripe's "warning" statuses are early inquiries, not yet a
  chargeback, so they map to the same words with `inquiry: true`.

  `open` is whether the money is still in question: the merchant has to answer, or the bank is deciding.
  `dueBy` is when the evidence has to be in; it is empty once the time has passed or nothing is asked.
*/
const DISPUTE_STATUS = {
  needs_response: 'needs_response',
  warning_needs_response: 'needs_response',
  under_review: 'under_review',
  warning_under_review: 'under_review',
  won: 'won',
  lost: 'lost',
  warning_closed: 'closed',
  charge_refunded: 'closed',
};

export const fromDispute = dispute => {
  const evidence = dispute.evidence_details ?? {};
  const status = DISPUTE_STATUS[dispute.status] ?? 'needs_response';
  return {
    ref: dispute.id,
    paymentRef: typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id ?? null,
    amount: dispute.amount,
    currency: dispute.currency,
    reason: dispute.reason || null,
    status,
    inquiry: String(dispute.status).startsWith('warning_'),
    open: status === 'needs_response' || status === 'under_review',
    dueBy: evidence.due_by ? new Date(evidence.due_by * 1000).toISOString() : null,
    pastDue: Boolean(evidence.past_due),
    hasEvidence: Boolean(evidence.has_evidence),
    created: new Date(dispute.created * 1000).toISOString(),
    livemode: Boolean(dispute.livemode),
  };
};

/* The site's own account's disputes, newest first, up to `limit`. A payment taken on a connected account has its dispute there. */
export const listDisputes = async ({ limit = 200 } = {}) => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];

  try {
    const found = await stripe.disputes.list({ limit: 100 }).autoPagingToArray({ limit });
    return [null, found.map(fromDispute)];
  } catch(err) {
    return failure(err);
  }
};

/* Where the dispute can be answered. Test and live accounts have different dashboards. */
export const disputeUrl = dispute => `https://dashboard.stripe.com/${dispute.livemode ? '' : 'test/'}disputes/${dispute.ref}`;

/*
  Verifies a webhook against the signing secret and returns the parsed event.

  `payload` must be the exact bytes that arrived. Stripe signs the raw body, so a payload that has
  been through JSON.parse and re-stringified fails verification even though it is the same data —
  key order and whitespace are part of what was signed.
*/
export const verifyEvent = async ({ payload, signature }) => {
  const { secretKey, webhookSecret } = await credentials();
  if(!secretKey) return [{ code: 409, msg: 'Stripe is not connected' }, null];
  if(!webhookSecret) return [{ code: 409, msg: 'No webhook signing secret is configured' }, null];
  if(!signature) return [{ code: 400, msg: 'Missing signature' }, null];

  try {
    return [null, clientFor(secretKey).webhooks.constructEvent(payload, signature, webhookSecret)];
  } catch {
    // Deliberately vague back to the caller: a signature check that explains itself is one that
    // helps somebody shape the next attempt.
    return [{ code: 400, msg: 'Signature verification failed' }, null];
  }
};

/*
  Translates a verified Stripe event into the small set of things this extension acts on.

  Anything not listed comes back as `ignored`, which is still recorded and still answered with a
  200 — telling Stripe an event failed makes it retry an event nothing was ever going to do
  anything with, for days.

  `connectedAccount` is the account an event happened on: Stripe sets `account` on every event that
  comes from a connected account and leaves it off the platform's own. The webhook only applies an
  event to a payment made on that same account — see server/utils/webhooks/receive.js.
*/
export const interpretEvent = event => ({ ...interpret(event), connectedAccount: event.account || null });

const interpret = event => {
  const object = event.data?.object || {};

  switch(event.type){
    case 'payment_intent.succeeded':
    case 'payment_intent.processing':
    case 'payment_intent.canceled':
    case 'payment_intent.requires_action':
    case 'payment_intent.amount_capturable_updated':
      return { kind: 'payment', providerRef: object.id, payment: fromIntent(object) };

    /*
      Stripe leaves a failed intent in `requires_payment_method` so the customer can try another
      card, so the status alone carries no sign that anything went wrong. The message is the only
      record of the decline, which is why it is lifted out explicitly here.
    */
    case 'payment_intent.payment_failed':
      return {
        kind: 'payment',
        providerRef: object.id,
        payment: { ...fromIntent(object), lastError: object.last_payment_error?.message || 'The payment failed' },
      };

    case 'charge.refunded':
      return {
        kind: 'refund',
        providerRef: object.payment_intent,
        amountRefunded: object.amount_refunded,
        // Empty on current API versions, which report only the total — see `listRefunds`.
        refunds: (object.refunds?.data || []).map(refundFrom),
      };

    case 'charge.refund.updated':
      return { kind: 'refund', providerRef: object.payment_intent, refunds: [refundFrom(object)] };

    case 'charge.dispute.created':
      return { kind: 'dispute', providerRef: object.payment_intent, disputed: true, reason: object.reason || null };

    /*
      A dispute won leaves the payment exactly as it was; a dispute lost has already taken the money
      back, and the flag is what stops the payment reading as a clean sale afterwards.
    */
    case 'charge.dispute.closed':
      return { kind: 'dispute', providerRef: object.payment_intent, disputed: object.status !== 'won', reason: object.reason || null };

    default:
      return { kind: 'ignored' };
  }
};
