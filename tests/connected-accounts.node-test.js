import Stripe from 'stripe';
import { fileURLToPath } from 'url';
import { eq, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { hook } from 'kempo/server/db/schema.js';
import { createHook, clearHandlerCache, deleteSetting, setSetting } from 'kempo/server/sdk.js';
import { kempoPayment, kempoPaymentEvent, kempoPaymentRefund } from '../server/db/schema.js';
import * as stripe from '../server/providers/stripe.js';
import { createPayment } from '../server/utils/payments/create.js';
import { refundOptionsFor, refundPayment } from '../server/utils/payments/actions.js';
import { getPayment, insertPayment, listPayments, listRefunds, newId } from '../server/utils/payments/store.js';
import { receiveVerifiedEvent, receiveWebhook } from '../server/utils/webhooks/receive.js';
import update from '../update.js';
import { databaseReachable, skipReason } from './testDatabase.js';

/*
  Payments taken on a connected account — Stripe Connect direct charges, which kempo-payouts makes.

  Nothing here talks to Stripe. What can be proved without it is proved: that a bad account or fee
  is refused before any processor is asked, that the row keeps both, that every later call is built
  with the account read off that row, that a refund gives the site's fee back unless told not to, and
  that an event already verified by kempo-payouts updates the payment the same way a platform event
  does — and only when it came from the account the payment was made on. The calls themselves are
  exercised against Stripe's test mode by the manual procedure in the README.
*/

const ACCOUNT = 'acct_1KempoPaymentsTest';
const OTHER = 'acct_1SomebodyElse';
const SECRET = 'whsec_kempo_payments_connected_test';
const OWNER = 'kempo-payments-connected-test';

const purge = async () => {
  await db.delete(kempoPaymentEvent).catch(() => {});
  await db.delete(kempoPaymentRefund).catch(() => {});
  await db.delete(kempoPayment).catch(() => {});
};

const disconnect = async () => {
  for(const name of ['stripe_secret_key', 'stripe_webhook_secret', 'stripe_publishable_key']) await deleteSetting('kempo-payments', name).catch(() => {});
};

const makePayment = async (overrides = {}) => {
  const [error, payment] = await insertPayment({
    provider: 'stripe',
    providerRef: `pi_${newId()}`,
    status: 'requires_payment_method',
    amount: 500,
    currency: 'usd',
    connectedAccount: ACCOUNT,
    applicationFee: 25,
    ...overrides,
  });
  if(error) throw new Error(error.msg);
  return payment;
};

const succeeded = (payment, { account = ACCOUNT, id = `evt_${newId()}` } = {}) => ({
  id,
  type: 'payment_intent.succeeded',
  ...(account ? { account } : {}),
  data: { object: { id: payment.providerRef, status: 'succeeded', amount: payment.amount, amount_received: payment.amount, currency: 'usd', capture_method: 'automatic', livemode: false } },
});

const recordHooks = async event => {
  await db.delete(hook).where(eq(hook.owner, OWNER));
  if(event) await createHook({ owner: OWNER, event, callback: fileURLToPath(new URL('./fixtures/record-hook.js', import.meta.url)) });
  clearHandlerCache();
  globalThis.kempoPaymentsHooks = [];
};

const tests = {
  'a connected account or fee that is wrong is refused before any processor is asked': async ({ pass, fail }) => {
    await disconnect();
    const cases = [
      [{ amount: 500, currency: 'usd', applicationFee: 25 }, 'a fee with no connected account'],
      [{ amount: 500, currency: 'usd', connectedAccount: 'not-an-account' }, 'an account id that is not one'],
      [{ amount: 500, currency: 'usd', connectedAccount: ACCOUNT, applicationFee: 500 }, 'a fee as large as the payment'],
      [{ amount: 500, currency: 'usd', connectedAccount: ACCOUNT, applicationFee: -1 }, 'a negative fee'],
      [{ amount: 500, currency: 'usd', connectedAccount: ACCOUNT, applicationFee: 2.5 }, 'a fee that is not whole'],
      [{ amount: 5000, currency: 'kwd', connectedAccount: ACCOUNT, applicationFee: 255 }, 'a three-decimal fee that is not whole hundredths'],
    ];
    for(const [input, what] of cases){
      const [error] = await createPayment(input);
      if(error?.code !== 400) return fail(`${what} gave ${JSON.stringify(error)} instead of a 400`);
    }

    // A valid one gets as far as the processor — which is not connected here, so it stops there.
    const [reached] = await createPayment({ amount: 500, currency: 'usd', connectedAccount: ACCOUNT, applicationFee: 25 });
    if(!/not connected/i.test(reached?.msg || '')) return fail(`a valid connected payment did not reach the processor: ${JSON.stringify(reached)}`);
    const [zero] = await createPayment({ amount: 500, currency: 'usd', connectedAccount: ACCOUNT, applicationFee: 0 });
    if(!/not connected/i.test(zero?.msg || '')) return fail(`a zero fee was refused: ${JSON.stringify(zero)}`);
    pass(`${cases.length} refused, and the valid ones reach the processor`);
  },

  'the row keeps the account and the fee, and payments can be listed by account': async ({ pass, fail }) => {
    await purge();
    const connected = await makePayment();
    await makePayment({ connectedAccount: OTHER });
    const plain = await makePayment({ connectedAccount: null, applicationFee: null });

    const [, read] = await getPayment(connected.id);
    if(read.connectedAccount !== ACCOUNT || read.applicationFee !== 25) return fail(`read back ${read.connectedAccount}, ${read.applicationFee}`);
    const [, ordinary] = await getPayment(plain.id);
    if(ordinary.connectedAccount !== null || ordinary.applicationFee !== null) return fail('an ordinary payment has connected-account values');

    const [, listed] = await listPayments({ connectedAccount: ACCOUNT });
    if(listed.total !== 1 || listed.payments[0].id !== connected.id) return fail(`listing by account found ${listed.total}`);
    await purge();
    pass('');
  },

  'every call about a connected payment is built with its account, and an ordinary one is unchanged': async ({ pass, fail }) => {
    if(stripe.requestOptions({}) !== undefined) return fail('an ordinary call now sends options it did not before');
    if(JSON.stringify(stripe.requestOptions({ idempotencyKey: 'k' })) !== '{"idempotencyKey":"k"}') return fail('the idempotency key alone changed shape');
    const options = stripe.requestOptions({ connectedAccount: ACCOUNT, idempotencyKey: 'k' });
    if(options?.stripeAccount !== ACCOUNT || options.idempotencyKey !== 'k') return fail(`options were ${JSON.stringify(options)}`);

    const plain = stripe.refundParams('pi_1', { amount: 100, reason: 'duplicate' });
    if('refund_application_fee' in plain) return fail('an ordinary refund now carries refund_application_fee');
    const keep = stripe.refundParams('pi_1', { amount: 100, refundApplicationFee: false });
    if(keep.refund_application_fee !== false) return fail('false was not sent');
    const give = stripe.refundParams('pi_1', { refundApplicationFee: true });
    if(give.refund_application_fee !== true) return fail('true was not sent');
    pass('');
  },

  'a refund gives the site’s fee back unless told not to, and the account comes from the row': async ({ pass, fail }) => {
    const connected = { connectedAccount: ACCOUNT, applicationFee: 25 };
    const byDefault = refundOptionsFor(connected);
    if(byDefault.connectedAccount !== ACCOUNT || byDefault.refundApplicationFee !== true) return fail(`default was ${JSON.stringify(byDefault)}`);
    if(refundOptionsFor(connected, { refundApplicationFee: false }).refundApplicationFee !== false) return fail('false was not kept');
    const noFee = refundOptionsFor({ connectedAccount: ACCOUNT, applicationFee: 0 });
    if('refundApplicationFee' in noFee || noFee.connectedAccount !== ACCOUNT) return fail(`a fee-less connected payment gave ${JSON.stringify(noFee)}`);
    if(Object.keys(refundOptionsFor({ connectedAccount: null, applicationFee: null })).length) return fail('an ordinary payment gained refund options');

    await purge();
    await disconnect();
    const payment = await makePayment({ status: 'succeeded', amountCaptured: 500 });
    const [bad] = await refundPayment(payment.id, { refundApplicationFee: 'yes' });
    if(bad?.code !== 400) return fail(`a non-boolean choice gave ${JSON.stringify(bad)}`);
    const [reached] = await refundPayment(payment.id, { amount: 100, refundApplicationFee: false });
    if(!/not connected/i.test(reached?.msg || '')) return fail(`a valid refund did not reach the processor: ${JSON.stringify(reached)}`);
    const [badKey] = await refundPayment(payment.id, { amount: 100, idempotencyKey: 42 });
    if(badKey?.code !== 400) return fail(`a key that is not text gave ${JSON.stringify(badKey)}`);
    const [keyed] = await refundPayment(payment.id, { amount: 100, idempotencyKey: 'refund-1' });
    if(!/not connected/i.test(keyed?.msg || '')) return fail(`a refund with a key did not reach the processor: ${JSON.stringify(keyed)}`);
    await purge();
    pass('');
  },

  'an event names the account it came from': async ({ pass, fail }) => {
    const connected = stripe.interpretEvent(succeeded({ providerRef: 'pi_1', amount: 1 }));
    if(connected.connectedAccount !== ACCOUNT || connected.kind !== 'payment') return fail(`got ${JSON.stringify(connected)}`);
    const platform = stripe.interpretEvent(succeeded({ providerRef: 'pi_1', amount: 1 }, { account: null }));
    if(platform.connectedAccount !== null) return fail('a platform event claims an account');
    if(stripe.interpretEvent({ id: 'evt', type: 'account.updated', account: ACCOUNT }).kind !== 'ignored') return fail('an account event is acted on here');
    pass('');
  },

  'a verified event updates a connected payment once, and fires the usual hook with the account on it': async ({ pass, fail }) => {
    await purge();
    await recordHooks('payment:succeeded');
    const payment = await makePayment();
    const event = succeeded(payment);

    const [error, first] = await receiveVerifiedEvent({ event });
    if(error || !first.handled) return fail(`not handled: ${JSON.stringify(error || first)}`);
    const [, after] = await getPayment(payment.id);
    if(after.status !== 'succeeded' || after.amountCaptured !== 500) return fail(`the payment is ${after.status}, ${after.amountCaptured}`);

    const [, again] = await receiveVerifiedEvent({ event });
    if(!again?.duplicate) return fail('the redelivery was not a duplicate');

    const heard = globalThis.kempoPaymentsHooks;
    await recordHooks(null);
    await purge();
    if(heard.length !== 1) return fail(`payment:succeeded fired ${heard.length} times`);
    if(heard[0].payment.connectedAccount !== ACCOUNT || heard[0].payment.applicationFee !== 25) return fail(`the hook's payment was ${JSON.stringify(heard[0].payment)}`);
    pass('');
  },

  'an event from a different account, or from the platform, does not touch a connected payment': async ({ pass, fail }) => {
    await purge();
    const payment = await makePayment();

    const [, wrong] = await receiveVerifiedEvent({ event: succeeded(payment, { account: OTHER }) });
    if(!wrong?.unmatched) return fail(`another account's event was ${JSON.stringify(wrong)}`);

    await setSetting('kempo-payments', 'stripe_secret_key', 'sk_test_connected_suite', 'secret', false, 'test');
    await setSetting('kempo-payments', 'stripe_webhook_secret', SECRET, 'secret', false, 'test');
    const payload = JSON.stringify(succeeded(payment, { account: null }));
    const signature = new Stripe('sk_test_connected_suite').webhooks.generateTestHeaderString({ payload, secret: SECRET });
    const [, platform] = await receiveWebhook({ provider: 'stripe', payload, signature });
    await disconnect();
    if(!platform?.unmatched) return fail(`a platform event was ${JSON.stringify(platform)}`);

    const [, still] = await getPayment(payment.id);
    if(still.status !== 'requires_payment_method') return fail(`the payment became ${still.status}`);

    const ordinary = await makePayment({ connectedAccount: null, applicationFee: null });
    const [, claimed] = await receiveVerifiedEvent({ event: succeeded(ordinary) });
    if(!claimed?.unmatched) return fail('a connected account\'s event was applied to the site\'s own payment');
    await purge();
    pass('');
  },

  'refunds and disputes on a connected payment come through the same way': async ({ pass, fail }) => {
    await purge();
    const payment = await makePayment({ status: 'succeeded', amountCaptured: 500 });

    const [refundError] = await receiveVerifiedEvent({ event: {
      id: `evt_${newId()}`, type: 'charge.refunded', account: ACCOUNT,
      data: { object: { id: 'ch_1', payment_intent: payment.providerRef, amount_refunded: 200, refunds: { data: [{ id: `re_${newId()}`, amount: 200, currency: 'usd', status: 'succeeded' }] } } },
    } });
    if(refundError) return fail(`the refund was not applied: ${refundError.msg}`);
    const [, refunded] = await getPayment(payment.id);
    const [, rows] = await listRefunds(payment.id);
    if(refunded.amountRefunded !== 200 || rows.length !== 1) return fail(`refunded ${refunded.amountRefunded} in ${rows.length} rows`);

    const [disputeError] = await receiveVerifiedEvent({ event: {
      id: `evt_${newId()}`, type: 'charge.dispute.created', account: ACCOUNT,
      data: { object: { payment_intent: payment.providerRef, reason: 'fraudulent' } },
    } });
    if(disputeError) return fail(`the dispute was not applied: ${disputeError.msg}`);
    const [, disputed] = await getPayment(payment.id);
    if(!disputed.disputed) return fail('the payment is not flagged as disputed');
    await purge();
    pass('');
  },

  'an event with nothing to go on is refused': async ({ pass, fail }) => {
    const [error] = await receiveVerifiedEvent({ event: { type: 'payment_intent.succeeded' } });
    if(error?.code !== 400) return fail(`got ${JSON.stringify(error)}`);
    const [missing] = await receiveVerifiedEvent({});
    if(missing?.code !== 400) return fail(`no event at all gave ${JSON.stringify(missing)}`);
    pass('');
  },

  'the browser config names the account a payment is on': async ({ pass, fail }) => {
    await setSetting('kempo-payments', 'stripe_publishable_key', 'pk_test_connected_suite', 'string', false, 'test');
    const [, plain] = await stripe.clientConfig();
    const [, connected] = await stripe.clientConfig({ connectedAccount: ACCOUNT });
    await disconnect();
    if('stripeAccount' in plain) return fail('the ordinary config gained an account');
    if(connected.stripeAccount !== ACCOUNT || connected.publishableKey !== 'pk_test_connected_suite') return fail(`got ${JSON.stringify(connected)}`);
    pass('');
  },

  /*
    A site that installed before these columns existed. kempo never alters an existing table, so
    update.js is the only thing that can add them — and without them every payment read fails.
  */
  'update adds the two columns to a payment table that predates them, and is safe to repeat': async ({ pass, fail }) => {
    await purge();
    await db.execute(sql.raw('ALTER TABLE "kempoPayment" DROP COLUMN IF EXISTS "connectedAccount"'));
    await db.execute(sql.raw('ALTER TABLE "kempoPayment" DROP COLUMN IF EXISTS "applicationFee"'));

    const { log, warn } = console;
    console.log = () => {};
    console.warn = () => {};
    try {
      await update();
      await update();
    } finally {
      console.log = log;
      console.warn = warn;
    }

    const columns = (await db.execute(sql`select column_name from information_schema.columns where table_name = 'kempoPayment'`)).map(row => row.column_name);
    if(!columns.includes('connectedAccount') || !columns.includes('applicationFee')) return fail(`the columns are ${columns.join(', ')}`);

    const payment = await makePayment();
    const [, read] = await getPayment(payment.id);
    await purge();
    if(read.connectedAccount !== ACCOUNT || read.applicationFee !== 25) return fail('a payment could not be stored after the update');
    pass('');
  },
};

export default databaseReachable ? tests : { 'connected accounts (SKIPPED)': async ({ pass }) => pass(`skipped: ${skipReason}`) };
