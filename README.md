# kempo-payments

A payment-processing extension for the [kempo](https://github.com/dustinpoissant/kempo) CMS. Take a
payment, capture an authorisation, issue a refund — without the code doing it knowing which processor
is behind it.

Stripe is the processor that ships. It is not the one the rest of the extension is written against:
everything goes through a small provider interface, and adding PayPal or Square later is a new file
in `server/providers/`, not a change to anything that ever called `createPayment`.

This kempo (CMS) extension depends on no other kempo extension. Taking money does not require a
product catalog, so there is no dependency on `kempo-commerce` — the arrow points the other way. That is also what makes it usable
for anything else that needs to charge a card: a subscription, a donation, a one-off invoice.

## What it is for

Other kempo (CMS) extensions. `kempo-payments` has no checkout of its own and no idea what anybody is buying.
It knows how to move money and how to tell you it moved.

```js
import { createPayment } from 'kempo-payments/sdk';

const [error, { payment, clientSecret }] = await createPayment({
  amount: 4999,                 // minor units, always — 4999 is $49.99
  currency: 'usd',
  owner: 'kempo-commerce',      // who is asking
  reference: order.id,          // their own id for what is being paid for
  userId: user?.id,             // null for a guest
  customerEmail: order.email,
  description: `Order ${order.number}`,
});
```

Hand `clientSecret` to the browser, mount the payment form against it, and then **stop watching the
browser**. Fulfilment hangs off the `payment:succeeded` hook, which is fired from the processor's
webhook — see [Hooks](#hooks-it-fires) for why that distinction is the whole design.

## Install

> **Not on npm yet.** Until it is published, install from GitHub:
> `npm install github:dustinpoissant/kempo-payments`, or clone it next to your site and use
> `file:../kempo-payments`.

```bash
npm install kempo-payments
```

Then install it from the admin panel, or:

```js
import installExtension from 'kempo/server/utils/extensions/installExtension.js';
await installExtension({ name: 'kempo-payments' });
```

Requires kempo **4.2.40 or later** — the first release with the encrypted `secret` setting type that
every credential here is stored as.

### `SETTINGS_ENCRYPTION_KEY` is required

Every credential this extension stores is a kempo `secret` setting, encrypted at rest. kempo cannot
encrypt anything without a key, so without one **no credential can be saved at all** — the settings
screen refuses, and installing prints a warning rather than leaving you to find out later.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put it in the site's environment as `SETTINGS_ENCRYPTION_KEY` and restart. Back it up in the same
place as `DATABASE_URL`: losing it makes every stored secret on the site unrecoverable, and rotating
it means re-entering every one of them.

## Connecting Stripe

Everything below is on the extension's own admin screen at
`/admin/extension/kempo-payments/` → **Settings**.

1. **Get the keys.** Stripe dashboard → Developers → API keys. In test mode these begin `pk_test_`
   and `sk_test_`. The secret key is shown once.
2. **Paste both in and save.** The screen says which mode the keys are for, read off the key
   prefixes rather than a switch — a switch can disagree with the keys, and "the toggle said test"
   is an expensive sentence.
3. **Add the webhook endpoint.** The screen shows the URL and the exact list of events to subscribe
   it to. Stripe gives you a signing secret (`whsec_…`) when you create it; paste that in too.
4. **Take a test payment.** The **Take a payment** tab runs the whole path — an intent created with
   the secret key, the real payment form built with the publishable key, a confirmation from the
   browser, and then the webhook coming back. Card `4242 4242 4242 4242`, any future expiry, any
   CVC.

If step 4 ends at "Paid, but nothing came back", the charge worked and the webhook did not. That is
the failure worth catching before launch, because in production it means orders that are paid for
and never fulfilled.

### Webhooks on localhost

Stripe cannot reach a development machine, so forward events to it instead:

```bash
stripe login
stripe listen --forward-to localhost:9876/payments/api/webhooks/stripe
```

`stripe listen` prints its **own** signing secret, different from the dashboard endpoint's. That is
the one to paste into the settings screen while developing.

## Wallets and buy-now-pay-later

Apple Pay, Google Pay, Klarna, Afterpay, Cash App Pay and Amazon Pay are not separate providers
here and never will be. `<k-pay-form>`'s Express Checkout button row offers whichever of them are
available to a given customer, drawn and driven entirely by Stripe — no extra integration, no
separate merchant account, and no code in this extension to add one. Modelling any of them as its
own provider module would duplicate an integration that is already done.

"Available" is a dashboard setting, not a code path: Apple Pay and Google Pay need the site's domain
registered with Stripe (Settings → Payment methods → Apple Pay, and HTTPS — neither works over
plain HTTP, which is why they are absent in local development); Klarna, Cash App Pay and Amazon Pay
need to be switched on the same way. Stripe shows the not-yet-activated ones anyway in test mode, as
a preview of what turning them on would look like — genuinely useful for building a checkout, worth
knowing it means nothing about what a real customer will see until the dashboard step is done.

Two of them are not iframes at all. Tapping the Apple Pay or Google Pay button opens the *native OS
payment sheet* — Face ID, the device's own card picker — not anything this extension or Stripe
draws; the wallet encrypts the card on-device and only ever hands Stripe an already-encrypted
token. Klarna, Afterpay and similar hand the customer to a screen that has to stay the provider's:
they are running a soft credit check or an underwriting decision that only they can make. There is
no "backend only" version of that step, which is also why this extension has no custom UI of its
own for any of them — Stripe's Express Checkout button, tapped, is the entire integration.

## Roadmap processors

Real second and third integrations, each with its own SDK, settlement and dispute model. Not
sequenced yet:

- **PayPal** — its Checkout SDK now covers what Braintree used to, which is why Braintree is not on
  this list rather than an oversight.
- **Square** — the obvious pairing for a site with a physical till.
- **Mollie** — European coverage Stripe prices differently.
- **Amazon Pay**.

**Adyen** was considered and excluded: its onboarding is enterprise, application-based and
account-manager-mediated, which does not fit a self-serve platform a small seller installs.

## The payment form

A reusable custom element, served from this extension:

```html
<script type="module" src="/payments/components/PaymentForm.js"></script>

<k-pay-form
  client-secret="pi_3..._secret_..."
  return-url="https://example.com/thank-you"
  submit-label="Pay $49.99"
></k-pay-form>
```

It shows two things, either of which may be absent depending on what is available:

- **Express Checkout** — a row of wallet buttons (Apple Pay, Google Pay, Link, and PayPal or Amazon
  Pay if enabled), drawn and managed entirely by Stripe. Automatically hidden when nothing is
  available for that customer's browser/account, with no gap left behind.
- **Card fields** — number, expiry, CVC and a plain ZIP/postal input, laid out and labelled by this
  extension's own markup. Each of the three card fields is a small iframe belonging to the
  processor; typing sends the digits from the customer's browser straight to it, never through this
  server, which is what keeps a kempo site out of PCI scope. There is no supported way to collect a
  card number in a plain kempo-ui `<input>` without taking on PCI scope yourself; this is as close
  as a card field gets to looking like the rest of the form.

Neither half of the modern `appearance` API reaches these three fields — confirmed by testing,
twice over, not assumed. Their box — background, border, radius, padding, focus ring — is real CSS
on the wrapper `<div>` (a `.k-pay-field` class this component injects once, copied property-for-
property from kempo-css's own `input` rule), because these particular Stripe fields render with a
transparent, unpadded iframe by design — the caller's page has always been expected to draw the
box — and `appearance.rules` (which does restyle Stripe's *newer* elements, Express Checkout
included) does not reach them at all. Their text colour uses the `style` option instead —
`style.base.color` / `style.base['::placeholder']`, Stripe's original, pre-`appearance` styling
mechanism for exactly this element family — because `appearance.variables.colorText` doesn't reach
them either, the same silent no-effect failure one layer deeper.

> **Do not put `<k-pay-form>` inside a shadow root.** Stripe's fields do not mount in one — they
> reserve their height and render nothing, with no error anywhere. If a checkout shows an empty box
> where a card field should be, this is why: something in the chain of custom elements above it is
> using shadow DOM. Everything hosting the form has to be light DOM.

Klarna, Afterpay, Cash App Pay and Amazon Pay are not excluded — see
[Wallets and buy-now-pay-later](#wallets-and-buy-now-pay-later) for how they appear through Express
Checkout the same as Apple Pay and Google Pay do, gated by dashboard activation rather than by
anything in this component. What this rewrite did trade away is Stripe's unified, all-methods,
single-tabbed-widget layout (the previous version of this component) in exchange for owning the
card fields' own look. Wanting that back is one component, not a rewrite: mount
`elements.create('payment')` instead of the split card fields and Express Checkout Element — the
server side of this extension does not care which client-side widget produced the confirmation.

| Event | When |
|---|---|
| `payment-succeeded` | the processor confirmed it in this browser |
| `payment-processing` | accepted, still settling — normal for bank debits |
| `payment-failed` | declined, or the details were rejected |

Use these to move the customer along. **Do not use them to fulfil an order.** A browser closed at
the wrong moment fires nothing at all, and a browser under someone's control fires whatever they
like.

## Hooks it fires

Registered by consumers in their own `kempo-config.json`, the same as any other kempo hook:

```json
"hooks": {
  "payment:succeeded": "hooks/payment-succeeded.js"
}
```

| Event | Data | When |
|---|---|---|
| `payment:created` | `{ payment }` | an attempt has been started; no money has moved |
| `payment:authorized` | `{ payment }` | held on the customer's card, waiting to be captured |
| `payment:succeeded` | `{ payment }` | **taken** — this is the one to fulfil against |
| `payment:failed` | `{ payment, error }` | the processor refused it |
| `payment:canceled` | `{ payment }` | abandoned, or the hold released |
| `payment:refunded` | `{ payment, refund }` | some or all of it given back |
| `payment:disputed` | `{ payment, disputed, reason }` | a chargeback opened, or closed |

`payment:succeeded` fires **once** per payment, on the transition into that state and nowhere else.
Redelivered webhooks, polling and admin screens all pass through the same place and produce no
transition, so nothing downstream sends a second confirmation email or ships a second box.

## Capture: automatic or manual

**Automatic** charges the card the moment the customer confirms. Right for anything delivered
immediately.

**Manual** places a hold and takes nothing until somebody captures it. Right for anything that
ships, where the amount can change or the order can be cancelled before it goes out. The hold
expires on its own — typically after seven days — and an authorisation nobody captured is money the
customer had reserved and the merchant never received.

The site-wide default is a setting; any individual payment can override it.

A capture method is **never guessed at**. `Manual` and `MANUAL ` are read as `manual` — case and
stray spaces are forgiven — but anything else (`hold`, `authorize`, a typo) is refused with a 400
naming the two that exist, before any processor is contacted. The alternative was falling back to
`automatic`, which turns "reserve this card" into "charge this card" for every mistyped word. The
same rule applies to the setting on the settings screen.

## Refunds and cancellations

They are not the same thing and the extension will not let them be confused:

- A payment that is **authorised but not captured** has had nothing taken. Releasing it is a
  **cancel**. Asking to refund it is refused, with that sentence rather than the processor's.
- A payment that **succeeded** can be refunded, in full or in part, repeatedly, until nothing is
  left outstanding.

The refunded total is recomputed from the individual refund rows rather than incremented, and every
refund is keyed by the processor's own reference. An admin refund and the webhook reporting the same
refund a second later are one row and one total — which is what stops a payment claiming twice the
money went back.

Refunds made directly in the processor's dashboard arrive by webhook and are recorded here too.
Stripe's `charge.refunded` event reports only the new running total, not which refunds make it up,
so the extension asks Stripe for the refunds on that payment before recording them. **Check with
Stripe** on a payment's screen reconciles the same way, and will pick up a refund whose webhook was
missed entirely.

A refund amount larger than what is left is refused with the remaining amount in the payment's own
currency (`Only $5.00 is left to refund on this payment`).

## When an event cannot be applied

The webhook marks an event handled only **after** it has been applied. If applying it fails — the
database would not write — the endpoint answers with an error, the claim on that event is released,
and Stripe's retry is processed rather than being answered "duplicate" and dropped. Text that
contains a NUL byte (which Postgres cannot store) is refused with a 400 when a caller supplies it
and stripped when the processor does, since by then the money has already moved.

## Permissions

| Permission | Allows |
|---|---|
| `payments:view` | See payments, what they were for, and what happened to them |
| `payments:create` | Take a payment — start a new charge over the API |
| `payments:capture` | Capture or cancel a payment that was only authorised |
| `payments:refund` | Refund a payment, in full or in part |
| `payments:settings` | Change the payment provider and its API credentials |

Two groups ship with them: **`kempo-payments:operator`** handles payments day to day — looking them
up, capturing, refunding — without being able to see or change credentials, and
**`kempo-payments:administrator`** adds connecting the site to a processor.

`payments:create` is deliberately not held by an ordinary visitor. The HTTP route that starts a
payment takes the amount from the request body, so an open version of it would let anybody decide
what they owe. A customer-facing checkout computes the amount on its own server and calls the SDK.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `provider` | `stripe` | Which processor money goes through |
| `currency` | `usd` | Used when the caller does not name one |
| `capture_method` | `automatic` | See [Capture](#capture-automatic-or-manual) |
| `stripe_publishable_key` | — | `pk_test_…` / `pk_live_…`; public by design |
| `stripe_secret_key` | — | `sk_test_…` / `sk_live_…`; encrypted, never leaves the server |
| `stripe_webhook_secret` | — | `whsec_…`; without it, no payment is ever confirmed |

## Server SDK

```js
import {
  createPayment, capturePayment, cancelPayment, refundPayment,
  getPayment, getPaymentByRef, paymentsForReference, listPayments,
  syncPayment, getClientSecret, refundableAmount, formatAmount,
} from 'kempo-payments/sdk';
```

Every one returns kempo's `[error, data]` tuple. None of them checks a permission — the HTTP routes
do that, and anything importing this is server-side code that has already decided it is allowed.

`paymentsForReference(owner, reference)` is the lookup a consumer wants: it knows its order number,
not a payment id.

## HTTP API

Served under the extension's public scope, `/payments/`.

| Route | Permission | |
|---|---|---|
| `GET /payments/api/config` | none | Provider and publishable key, for the payment form |
| `GET /payments/api/payments` | `payments:view` | Filtered, paged list |
| `POST /payments/api/payments` | `payments:create` | Start a payment |
| `GET /payments/api/payments/:id` | `payments:view` | One payment, its refunds and its event log |
| `GET /payments/api/payments/:id/client-secret` | `payments:create` | Re-mount a form against a payment in flight |
| `POST /payments/api/payments/:id/capture` | `payments:capture` | |
| `POST /payments/api/payments/:id/cancel` | `payments:capture` | |
| `POST /payments/api/payments/:id/refund` | `payments:refund` | |
| `POST /payments/api/payments/:id/sync` | `payments:view` | Re-read from the processor |
| `GET /payments/api/summary` | `payments:view` | Counts and totals per currency |
| `GET`/`PUT /payments/api/settings` | `payments:settings` | Never returns a credential, only whether one is set |
| `POST /payments/api/webhooks/:provider` | signature | The processor's own endpoint |

## Amounts are integers

Always the currency's smallest unit. `4999` is $49.99. `1200` is ¥1,200, because yen have no minor
unit at all — and a Kuwaiti dinar has three decimal places, not two.

Floats are refused rather than converted. A caller passing `49.99` meant $49.99 and would be
charging five cents; the processor would accept that instruction without complaint. `toMinor()` is
exported for the places where a human genuinely typed a decimal into a box.

## Adding a provider

One file in `server/providers/`, exporting `name`, `label`, `webhookPath`, `webhookEvents`,
`signatureHeader`, `credentialFields`, and the functions `status`, `clientConfig`, `createIntent`,
`retrieveIntent`, `capture`, `cancel`, `refund`, `verifyEvent` and `interpretEvent`. Add its
credential settings to `kempo-config.json` and register it in `server/providers/index.js`.

The contract is documented in full at the top of `server/providers/index.js`. Statuses coming out of
it must be kempo's, not the processor's — mapping is the provider module's job, precisely so the
rest of the extension has one vocabulary rather than one per processor.

## What this does not do

- **Subscriptions and recurring billing.** A separate concern with its own state machine, dunning
  and proration. This extension is the thing one would be built on.
- **Saved cards and stored customers.** Nothing is kept on file; every payment stands alone.
- **Payouts, balances and reconciliation.** The processor's dashboard is the ledger.
- **Answering disputes.** They are flagged here and answered there — evidence submission is a
  processor-specific workflow with deadlines attached.
- **Tax.** That is `kempo-tax`, deliberately separate: "compute what is owed" and "move money" are
  orthogonal, and merging them would stop anybody swapping in their own tax calculator.
- **A checkout.** No cart, no order, no idea what is being bought. That is `kempo-commerce`.

## Uninstalling

The tables are dropped, which loses this site's record of every payment it has taken. That record is
a copy — the charges themselves live at the processor and are entirely unaffected, and any of them
can still be refunded from its dashboard.

Uninstalling names any payment still authorised and uncaptured on the way out. Those are holds on
real cards that nothing will capture or release once the extension is gone.

## Development

```bash
npm install
npm run link:local        # symlinks sibling kempo checkouts
docker compose up -d      # test database on port 5439
DATABASE_URL=postgresql://kempo:kempo@localhost:5439/kempo_payments_test npx drizzle-kit push --force
npm test
```

The database suites (data layer, lifecycle, webhooks) **skip themselves** when no database is
reachable, and a skip reads as a pass — check for `(SKIPPED)` before believing a green run covered
them. They also skip themselves when `DATABASE_URL` names a database that does not end in `_test`,
because they **empty the payment tables** first: pointing one at a real site's database would
delete its payments. The webhook suite additionally needs `SETTINGS_ENCRYPTION_KEY` (any 64 hex
characters will do) to store the signing secret it verifies against.

No Stripe account is needed for any test: every provider response in the suite is a literal, and
webhook events are signed with Stripe's own test-signature helper, because a suite that needs an
account is a suite nobody runs.

## License

MIT
