import { sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { getSetting, setSetting, deleteSetting } from 'kempo/server/sdk.js';
import { kempoPayment, kempoPaymentEvent, kempoPaymentRefund } from '../server/db/schema.js';
import {
  getPayment, getPaymentByRef, insertPayment, listPayments, listRefunds,
  paymentsForReference, recordRefund, refundedTotal, summary, updatePayment, newId,
} from '../server/utils/payments/store.js';
import { databaseReachable, skipReason } from './testDatabase.js';
import { refundPayment } from '../server/utils/payments/actions.js';
import { applyDispute, applyProviderState, applyRefunds } from '../server/utils/payments/sync.js';

/*
  The data layer against a real database.

  The unit suites cover the arithmetic. What only shows up here is everything that depends on the
  database actually behaving the way the code assumes it does — a primary key that has to reject a
  second copy of the same webhook, a refunded total that has to be recomputed rather than
  incremented, an update that has to leave alone the columns it was given no answer for.

  No processor is involved. Every provider response below is a literal, because the point is what
  this extension does with one, and a suite that needs a Stripe account is a suite nobody runs.

  Requires a reachable Postgres carrying kempo's schema and this extension's
  (`npx drizzle-kit push --force`). Skips itself when there is none rather than failing.
*/


const skipped = reason => ({
  'data layer (SKIPPED)': async ({ pass }) => pass(`skipped: ${reason}`),
});

const purge = async () => {
  await db.delete(kempoPaymentEvent).catch(() => {});
  await db.delete(kempoPaymentRefund).catch(() => {});
  await db.delete(kempoPayment).catch(() => {});
};

const makePayment = async (overrides = {}) => {
  const [error, payment] = await insertPayment({
    provider: 'stripe',
    providerRef: `pi_${newId()}`,
    status: 'succeeded',
    amount: 5000,
    amountCaptured: 5000,
    currency: 'usd',
    owner: 'kempo-commerce',
    reference: 'order-1',
    description: 'A thing',
    ...overrides,
  });
  if(error) throw new Error(error.msg);
  return payment;
};

export default !databaseReachable ? skipped(`${skipReason} — point DATABASE_URL at a *_test database and run drizzle-kit push`) : {
  'a payment can be found by our id, by the processor’s, and by what it was for': async ({ pass, fail }) => {
    await purge();
    const created = await makePayment({ providerRef: 'pi_lookup', reference: 'order-42' });

    const [byIdError, byId] = await getPayment(created.id);
    if(byIdError || byId.id !== created.id) return fail('lookup by id failed');

    const [byRefError, byRef] = await getPaymentByRef('stripe', 'pi_lookup');
    if(byRefError || byRef.id !== created.id) return fail('lookup by provider reference failed — webhooks depend on this');

    const [byOrderError, byOrder] = await paymentsForReference('kempo-commerce', 'order-42');
    if(byOrderError || byOrder.length !== 1) return fail('lookup by owner and reference failed');

    const [missingError] = await getPaymentByRef('stripe', 'pi_nothing');
    if(missingError?.code !== 404) return fail('an unknown reference should be a 404, not an empty success');

    await purge();
    pass('all three lookups resolve to the same row');
  },

  /*
    The processor is asked for a payment in several different ways, and not all of them can answer
    every question. An unexpanded charge reports no refund total; writing 0 for it would erase a
    real refund from the record while leaving it on the customer's statement.
  */
  'applying a provider state leaves alone what the provider had no answer for': async ({ pass, fail }) => {
    await purge();
    const payment = await makePayment({ amountRefunded: 1500 });

    const [error, result] = await applyProviderState(payment, {
      status: 'succeeded',
      amountCaptured: 5000,
      amountRefunded: undefined,
      currency: 'usd',
    });
    if(error) return fail(error.msg);

    if(result.payment.amountRefunded !== 1500){
      return fail(`the refunded total became ${result.payment.amountRefunded} — an undefined answer overwrote a real one`);
    }

    await purge();
    pass('undefined means "not asked", not zero');
  },

  'nothing is written when nothing changed': async ({ pass, fail }) => {
    await purge();
    const payment = await makePayment();

    const [error, result] = await applyProviderState(payment, {
      status: payment.status,
      amountCaptured: payment.amountCaptured,
      currency: payment.currency,
      captureMethod: payment.captureMethod,
      livemode: payment.livemode,
    });
    if(error) return fail(error.msg);

    /*
      This is what makes a redelivered webhook harmless. `changed` false is also what stops the
      hooks firing, and the hooks are what send emails and ship boxes.
    */
    if(result.changed) return fail('an identical state reported a change, which would re-fire every hook');

    await purge();
    pass('a repeat report is a no-op');
  },

  'a decline message is kept and then cleared when something works': async ({ pass, fail }) => {
    await purge();
    const payment = await makePayment({ status: 'requires_payment_method', amountCaptured: 0 });

    const [failError, failed] = await applyProviderState(
      payment,
      { status: 'requires_payment_method', lastError: 'Your card was declined.' },
      { failed: true },
    );
    if(failError) return fail(failError.msg);
    if(failed.payment.lastError !== 'Your card was declined.') return fail('the decline was not recorded');

    const [okError, ok] = await applyProviderState(failed.payment, { status: 'succeeded', amountCaptured: 5000 });
    if(okError) return fail(okError.msg);
    if(ok.payment.lastError !== null){
      return fail('a payment that eventually succeeded still shows the first card’s decline');
    }

    await purge();
    pass('the last thing that went wrong does not outlive the thing that went right');
  },

  /*
    An admin refund and the webhook reporting the same refund are two accounts of one event. Keying
    on the processor's own reference is what makes them one row; recomputing the total from those
    rows is what makes the payment's `amountRefunded` right however many times it is reported.
  */
  'the same refund reported twice is recorded once': async ({ pass, fail }) => {
    await purge();
    const payment = await makePayment();

    const refund = { ref: 're_same', amount: 2000, currency: 'usd', status: 'pending', reason: 'Damaged' };

    const [firstError, first] = await applyRefunds(payment, [refund], { issuedBy: 'user-1' });
    if(firstError) return fail(firstError.msg);
    if(first.payment.amountRefunded !== 2000) return fail(`after one refund the total was ${first.payment.amountRefunded}`);

    const [secondError, second] = await applyRefunds(first.payment, [{ ...refund, status: 'succeeded' }]);
    if(secondError) return fail(secondError.msg);

    if(second.payment.amountRefunded !== 2000){
      return fail(`a redelivered refund made the total ${second.payment.amountRefunded} — the money was counted twice`);
    }

    const [, rows] = await listRefunds(payment.id);
    if(rows.length !== 1) return fail(`${rows.length} refund rows for one refund`);
    if(rows[0].status !== 'succeeded') return fail('the later report should update the status');
    if(rows[0].issuedBy !== 'user-1') return fail('the webhook blanked out who issued it');
    if(rows[0].reason !== 'Damaged') return fail('the webhook blanked out the reason');

    await purge();
    pass('one refund, one row, and the attribution survives the webhook');
  },

  'two partial refunds add up': async ({ pass, fail }) => {
    await purge();
    const payment = await makePayment();

    const [, first] = await applyRefunds(payment, [{ ref: 're_a', amount: 1500, currency: 'usd', status: 'succeeded' }]);
    const [, second] = await applyRefunds(first.payment, [{ ref: 're_b', amount: 2000, currency: 'usd', status: 'succeeded' }]);

    if(second.payment.amountRefunded !== 3500){
      return fail(`two partial refunds totalled ${second.payment.amountRefunded}, expected 3500`);
    }

    const [, total] = await refundedTotal(payment.id);
    if(total !== 3500) return fail(`the recomputed total was ${total}`);

    await purge();
    pass('partial refunds accumulate without being double counted');
  },

  'a failed refund does not count against the payment': async ({ pass, fail }) => {
    await purge();
    const payment = await makePayment();

    await applyRefunds(payment, [{ ref: 're_ok', amount: 1000, currency: 'usd', status: 'succeeded' }]);
    await recordRefund({
      paymentId: payment.id, provider: 'stripe', providerRef: 're_bad',
      amount: 2000, currency: 'usd', status: 'failed',
    });

    const [, total] = await refundedTotal(payment.id);
    if(total !== 1000) return fail(`a failed refund was counted — the total was ${total}`);

    await purge();
    pass('only refunds that went through, or are still going, reduce what is owed back');
  },

  /*
    The one guarantee that makes webhook handling idempotent. kempo's installer creates primary
    keys and no other constraints, which is exactly why the event id *is* the primary key.
  */
  'the same webhook event cannot be recorded twice': async ({ pass, fail }) => {
    await purge();

    const row = {
      id: 'stripe:evt_dupe',
      provider: 'stripe',
      providerEventId: 'evt_dupe',
      type: 'payment_intent.succeeded',
      payload: { id: 'evt_dupe' },
      createdAt: new Date(),
    };

    const firstInsert = await db.insert(kempoPaymentEvent).values(row).onConflictDoNothing().returning();
    if(firstInsert.length !== 1) return fail('the first delivery was not recorded');

    const secondInsert = await db.insert(kempoPaymentEvent).values(row).onConflictDoNothing().returning();
    if(secondInsert.length !== 0){
      return fail('a redelivered event was recorded again — every hook on it would fire a second time');
    }

    await purge();
    pass('a redelivered event claims nothing, so nothing acts on it twice');
  },

  'a dispute flags the payment and closing it in our favour clears the flag': async ({ pass, fail }) => {
    await purge();
    const payment = await makePayment();

    const [, opened] = await applyDispute(payment, { disputed: true, reason: 'fraudulent' });
    if(!opened.payment.disputed) return fail('the dispute was not recorded');

    const [, repeat] = await applyDispute(opened.payment, { disputed: true, reason: 'fraudulent' });
    if(repeat.changed) return fail('the same dispute reported twice looked like a new one');

    const [, won] = await applyDispute(opened.payment, { disputed: false });
    if(won.payment.disputed) return fail('winning should clear the flag');

    await purge();
    pass('disputes open, stay open, and close');
  },

  'listing filters, pages and totals': async ({ pass, fail }) => {
    await purge();

    for(let index = 0; index < 5; index++){
      await makePayment({ status: index < 3 ? 'succeeded' : 'requires_capture', amount: 1000 * (index + 1) });
    }

    const [error, page] = await listPayments({ limit: 2 });
    if(error) return fail(error.msg);
    if(page.payments.length !== 2) return fail(`a page of 2 returned ${page.payments.length}`);
    if(page.total !== 5) return fail(`the total was ${page.total}, expected 5`);

    const [, filtered] = await listPayments({ status: 'requires_capture' });
    if(filtered.total !== 2) return fail(`filtering by status gave ${filtered.total}, expected 2`);

    const [, multi] = await listPayments({ status: ['succeeded', 'requires_capture'] });
    if(multi.total !== 5) return fail('a list of statuses should match any of them');

    const [, stats] = await summary();
    const captured = stats.byStatus.filter(entry => entry.status === 'succeeded').reduce((sum, entry) => sum + entry.captured, 0);
    if(captured !== 5000 + 5000 + 5000) return fail(`the captured total was ${captured}`);

    await purge();
    pass('filters, paging and the summary agree with each other');
  },

  'updating a payment that does not exist is a 404, not a silent success': async ({ pass, fail }) => {
    const [error] = await updatePayment('nope', { status: 'succeeded' });
    if(error?.code !== 404) return fail(`updating a missing payment gave ${JSON.stringify(error)}`);
    pass('a write that matched nothing says so');
  },

  /*
    Refusals that happen before the processor is asked anything, so they need a row and nothing
    else. The over-amount message used to quote the raw minor-unit number ("Only 500 is left") on a
    screen that shows "$5.00" everywhere else — an admin reading it could not tell 500 what.
  */
  'a refund the payment cannot cover is refused in the currency’s own terms': async ({ pass, fail }) => {
    await purge();
    const dollars = await makePayment({ amount: 500, amountCaptured: 500 });
    const yen = await makePayment({ amount: 500, amountCaptured: 500, currency: 'jpy' });

    const [tooMuch] = await refundPayment(dollars.id, { amount: 600 });
    if(tooMuch?.code !== 400) return fail(`over-refunding gave ${JSON.stringify(tooMuch)} instead of a 400`);
    if(!tooMuch.msg.includes('$5.00')) return fail(`the message does not show the amount as money: ${tooMuch.msg}`);

    const [tooMuchYen] = await refundPayment(yen.id, { amount: 600 });
    if(!tooMuchYen?.msg.includes('¥500')) return fail(`a zero-decimal currency was formatted as if it had cents: ${tooMuchYen?.msg}`);

    for(const amount of [0, -100, 12.5, '500']){
      const [error, result] = await refundPayment(dollars.id, { amount });
      if(result || error?.code !== 400) return fail(`${JSON.stringify(amount)} was not refused with a 400`);
    }

    if((await listRefunds(dollars.id))[1]?.length) return fail('a refused refund left a row behind');
    await purge();
    pass('over-amount, zero, negative, fractional and string amounts are all refused; nothing recorded');
  },

  /*
    Not this extension's code, but its hardest dependency: every credential it stores goes through
    kempo's secret setting type. If that round trip breaks — or the encryption key is missing —
    nothing here can take a payment, and the failure otherwise appears as an empty settings screen.
  */
  'a credential round-trips through encryption': async ({ pass, fail }) => {
    if(!process.env.SETTINGS_ENCRYPTION_KEY){
      return pass('skipped: SETTINGS_ENCRYPTION_KEY is not set, so secret settings cannot be exercised');
    }

    const value = `sk_test_${newId()}`;
    const [setError] = await setSetting('kempo-payments-test', 'probe', value, 'secret', false, 'test');
    if(setError) return fail(`storing a secret failed: ${setError.msg}`);

    const [getError, read] = await getSetting('kempo-payments-test', 'probe');
    if(getError) return fail(`reading a secret failed: ${getError.msg}`);
    if(read !== value) return fail('a secret did not come back as it went in');

    const [row] = await db.execute(sql`select value from "setting" where name = 'kempo-payments-test:probe'`);
    if(row?.value === value) return fail('the secret is stored in plain text');

    await deleteSetting('kempo-payments-test', 'probe').catch(() => {});
    pass('credentials are encrypted at rest and decrypt for server-side use');
  },
};
