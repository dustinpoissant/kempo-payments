import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { setSetting, deleteSetting } from 'kempo/server/sdk.js';
import { kempoPayment, kempoPaymentEvent, kempoPaymentRefund } from '../server/db/schema.js';
import { getPayment, insertPayment, listRefunds, newId } from '../server/utils/payments/store.js';
import { receiveWebhook } from '../server/utils/webhooks/receive.js';
import { databaseReachable, skipReason } from './testDatabase.js';

/*
  The webhook endpoint, driven with events signed the way Stripe signs them.

  Nothing here talks to Stripe: `generateTestHeaderString` produces a real signature for a secret we
  choose, and `constructEvent` — the same call production makes — verifies it. That makes this the
  first coverage of the endpoint that decides what is true about the money, which the pure
  translation tests in stripe-events.node-test.js deliberately stop short of.

  Needs SETTINGS_ENCRYPTION_KEY (the credentials are secret settings) as well as a *_test database,
  and skips itself without either.
*/

const SECRET = 'whsec_kempo_payments_test';
const PROBES = ['stripe_secret_key', 'stripe_webhook_secret'];

const purge = async () => {
  await db.delete(kempoPaymentEvent).catch(() => {});
  await db.delete(kempoPaymentRefund).catch(() => {});
  await db.delete(kempoPayment).catch(() => {});
};

const connect = async () => {
  await setSetting('kempo-payments', 'stripe_secret_key', 'sk_test_webhook_suite', 'secret', false, 'test');
  await setSetting('kempo-payments', 'stripe_webhook_secret', SECRET, 'secret', false, 'test');
};

const disconnect = async () => {
  for(const name of PROBES) await deleteSetting('kempo-payments', name).catch(() => {});
};

const sign = payload => new Stripe('sk_test_webhook_suite').webhooks.generateTestHeaderString({ payload, secret: SECRET });

const deliver = (event, { signature } = {}) => {
  const payload = JSON.stringify(event);
  return receiveWebhook({ provider: 'stripe', payload, signature: signature ?? sign(payload) });
};

const makePayment = async (overrides = {}) => {
  const [error, payment] = await insertPayment({
    provider: 'stripe',
    providerRef: `pi_${newId()}`,
    status: 'requires_payment_method',
    amount: 5000,
    currency: 'usd',
    ...overrides,
  });
  if(error) throw new Error(error.msg);
  return payment;
};

const succeeded = (payment, id = `evt_${newId()}`) => ({
  id,
  type: 'payment_intent.succeeded',
  data: { object: { id: payment.providerRef, status: 'succeeded', amount: payment.amount, amount_received: payment.amount, currency: 'usd', capture_method: 'automatic', livemode: false } },
});

const refunded = (payment, refund, id = `evt_${newId()}`) => ({
  id,
  type: 'charge.refunded',
  data: { object: { id: 'ch_1', payment_intent: payment.providerRef, amount_refunded: refund.amount, refunds: { data: [{ id: `re_${newId()}`, currency: 'usd', status: 'succeeded', ...refund }] } } },
});

const eventRows = async id => db.select().from(kempoPaymentEvent).where(eq(kempoPaymentEvent.id, `stripe:${id}`));

const unavailable = !databaseReachable ? skipReason : !process.env.SETTINGS_ENCRYPTION_KEY ? 'SETTINGS_ENCRYPTION_KEY is not set, so the webhook secret cannot be stored' : null;

export default unavailable ? { 'webhooks (SKIPPED)': async ({ pass }) => pass(`skipped: ${unavailable}`) } : {
  'an event with a bad or missing signature is refused and leaves no trace': async ({ pass, fail }) => {
    await purge();
    await connect();
    const payment = await makePayment();
    const event = succeeded(payment);

    const [forged] = await deliver(event, { signature: 't=1,v1=deadbeef' });
    if(forged?.code !== 400) return fail(`a forged signature gave ${JSON.stringify(forged)} instead of a 400`);

    const [unsigned] = await receiveWebhook({ provider: 'stripe', payload: JSON.stringify(event), signature: null });
    if(unsigned?.code !== 400) return fail(`a missing signature gave ${JSON.stringify(unsigned)} instead of a 400`);

    if((await eventRows(event.id)).length) return fail('an unverified event was recorded');
    const [, unchanged] = await getPayment(payment.id);
    if(unchanged.status !== 'requires_payment_method') return fail('an unverified event changed a payment');

    await purge();
    await disconnect();
    pass('forged and unsigned requests are 400s that touch nothing');
  },

  'a verified event is applied once, and a redelivery is a no-op': async ({ pass, fail }) => {
    await purge();
    await connect();
    const payment = await makePayment();
    const event = succeeded(payment);

    const [error, first] = await deliver(event);
    if(error || !first.handled) return fail(`the first delivery was not handled: ${JSON.stringify(error || first)}`);

    const [, updated] = await getPayment(payment.id);
    if(updated.status !== 'succeeded' || updated.amountCaptured !== 5000) return fail(`the payment was not brought up to date: ${updated.status}, ${updated.amountCaptured}`);

    const [row] = await eventRows(event.id);
    if(!row?.handledAt || row.paymentId !== payment.id) return fail('the event log does not show it handled against this payment');

    const [again, second] = await deliver(event);
    if(again || !second.duplicate) return fail(`a redelivery was not recognised: ${JSON.stringify(again || second)}`);

    await purge();
    await disconnect();
    pass('applied, logged against the payment, and the second delivery did nothing');
  },

  /*
    The one that lost money records. An event was marked handled *before* it was applied, so when
    applying failed — a database that would not write — the non-2xx made the processor retry, and
    the retry found the claim and answered "duplicate". Nothing was ever applied, permanently.

    The failure is forced with a refund larger than an integer column holds. The redelivery uses the
    same event id with a payload that does apply: what is being proven is that a retry is attempted
    at all, not that it succeeds.
  */
  'an event that fails to apply does not keep its claim, so the retry is not swallowed': async ({ pass, fail }) => {
    await purge();
    await connect();
    const payment = await makePayment({ status: 'succeeded', amountCaptured: 5000 });
    const id = `evt_${newId()}`;

    const [error] = await deliver(refunded(payment, { amount: 99999999999 }, id));
    if(!error) return fail('an unrecordable refund was reported as handled');
    if(error.code < 500) return fail(`a failure to record should tell the processor to retry, not ${error.code}`);
    if((await eventRows(id)).length) return fail('the failed event kept its claim — its retry would be answered "duplicate" and dropped');

    const [retryError, retry] = await deliver(refunded(payment, { amount: 1000 }, id));
    if(retryError) return fail(`the retry was refused: ${JSON.stringify(retryError)}`);
    if(retry.duplicate) return fail('the retry was swallowed as a duplicate');

    const [, after] = await getPayment(payment.id);
    if(after.amountRefunded !== 1000) return fail(`the retry did not record the refund: ${after.amountRefunded}`);

    await purge();
    await disconnect();
    pass('a failed apply releases the event; the retry is applied and the refund recorded');
  },

  /*
    Text that comes from the processor cannot be refused — by the time it arrives the money has
    moved — so it has to be storable. A refund reason containing a NUL byte was accepted by Stripe,
    could not be inserted by Postgres, and left the payment permanently showing no refund.
  */
  'a refund reason with a NUL byte from the processor is recorded, cleaned': async ({ pass, fail }) => {
    await purge();
    await connect();
    const payment = await makePayment({ status: 'succeeded', amountCaptured: 5000 });

    const [error, result] = await deliver(refunded(payment, { amount: 100, metadata: { reason: 'a\u0000b' } }));
    if(error || !result.handled) return fail(`the event was not handled: ${JSON.stringify(error || result)}`);

    const [, after] = await getPayment(payment.id);
    if(after.amountRefunded !== 100) return fail(`the refund was not counted: ${after.amountRefunded}`);

    const [, refunds] = await listRefunds(payment.id);
    if(refunds.length !== 1 || refunds[0].reason !== 'ab') return fail(`the reason was stored as ${JSON.stringify(refunds[0]?.reason)}, not "ab"`);

    await purge();
    await disconnect();
    pass('recorded with the NUL byte removed');
  },
};
