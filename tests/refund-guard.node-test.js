import { fileURLToPath } from 'url';
import { eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { hook } from 'kempo/server/db/schema.js';
import { createHook, clearHandlerCache, deleteSetting } from 'kempo/server/sdk.js';
import { kempoPayment, kempoPaymentRefund } from '../server/db/schema.js';
import { insertPayment, newId } from '../server/utils/payments/store.js';
import { refundPayment } from '../server/utils/payments/actions.js';
import { databaseReachable, skipReason } from './testDatabase.js';

/*
  `payment:refunding`: the guard the extension that took a payment uses to refuse a refund of it —
  kempo-credits, for credits that have since been spent.

  No processor is connected, so a refund that gets past the guard stops at "Stripe is not connected"
  and one the guard refuses stops with the guard's own words. Which of the two comes back is the
  whole assertion, and nothing here can move money.
*/

const OWNER = 'kempo-payments-refund-guard-test';
const fixture = name => fileURLToPath(new URL(`./fixtures/${name}.js`, import.meta.url));

const guard = async name => {
  await db.delete(hook).where(eq(hook.owner, OWNER));
  if(name) await createHook({ owner: OWNER, event: 'payment:refunding', callback: fixture(name) });
  clearHandlerCache();
};

const paidPayment = async () => {
  const [error, payment] = await insertPayment({
    provider: 'stripe', providerRef: `pi_${newId()}`, status: 'succeeded', amount: 5000, amountCaptured: 5000, currency: 'usd',
  });
  if(error) throw new Error(error.msg);
  return payment;
};

const tests = {
  'a guard that throws refuses the refund before the processor is asked': async ({ pass, fail }) => {
    for(const name of ['stripe_secret_key', 'stripe_webhook_secret']) await deleteSetting('kempo-payments', name).catch(() => {});
    await guard('refuse-refund');
    const payment = await paidPayment();

    const [error] = await refundPayment(payment.id, { amount: 1000, reason: 'test' });
    if(error?.code !== 409 || error.msg !== 'Refused by the test guard') return fail(`got ${JSON.stringify(error)}`);

    const refunds = await db.select().from(kempoPaymentRefund).where(eq(kempoPaymentRefund.paymentId, payment.id));
    if(refunds.length) return fail('a refused refund was recorded');
    pass('');
  },

  'a guard that does not throw lets the refund through, and is told the amount': async ({ pass, fail }) => {
    await guard('record-hook');
    globalThis.kempoPaymentsHooks = [];
    const payment = await paidPayment();

    const [error] = await refundPayment(payment.id, { amount: 1200, reason: 'test' });
    if(!/not connected/i.test(error?.msg || '')) return fail(`expected to reach the unconnected processor, got ${JSON.stringify(error)}`);

    const [heard] = globalThis.kempoPaymentsHooks;
    if(heard?.amount !== 1200 || heard?.payment?.id !== payment.id) return fail(`the guard was given ${JSON.stringify(heard)}`);
    pass('');
  },

  'with no guard registered a refund goes ahead as before': async ({ pass, fail }) => {
    await guard(null);
    const payment = await paidPayment();
    const [error] = await refundPayment(payment.id, { reason: 'test' });
    if(!/not connected/i.test(error?.msg || '')) return fail(`got ${JSON.stringify(error)}`);

    await db.delete(kempoPayment).where(eq(kempoPayment.provider, 'stripe'));
    pass('');
  },
};

export default databaseReachable ? tests : { 'refund guard (SKIPPED)': async ({ pass }) => pass(`skipped: ${skipReason}`) };
