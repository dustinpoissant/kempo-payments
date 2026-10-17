import { eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoPayment } from '../server/db/schema.js';
import { insertPayment, newId } from '../server/utils/payments/store.js';
import { listDisputes } from '../server/utils/disputes/list.js';
import * as stripe from '../server/providers/stripe.js';
import { databaseReachable, skipReason } from './testDatabase.js';

/*
  Disputes (chargebacks) read from the processor: Stripe's shape in kempo's words, and the list tied to
  the payments this site made. No processor is contacted: the translation is pure and the list takes a
  stand-in provider.
*/

const DAY = 86400;
const inDays = days => Math.floor(Date.now() / 1000) + days * DAY;

const dispute = (overrides = {}) => ({
  id: 'dp_1',
  status: 'needs_response',
  amount: 5000,
  currency: 'usd',
  reason: 'fraudulent',
  payment_intent: 'pi_1',
  created: 1_760_000_000,
  livemode: false,
  evidence_details: { due_by: inDays(5), past_due: false, has_evidence: false, submission_count: 0 },
  ...overrides,
});

/* A provider that answers with fixed disputes instead of asking Stripe. */
const provider = disputes => ({
  name: 'stripe',
  label: 'Stripe',
  listDisputes: async () => [null, disputes.map(stripe.fromDispute)],
  disputeUrl: stripe.disputeUrl,
});

const tests = {
  'a dispute that needs an answer is open, with its deadline and what it is about': async ({ pass, fail }) => {
    const value = stripe.fromDispute(dispute());
    if(value.status !== 'needs_response' || !value.open || value.inquiry) return fail(`status ${JSON.stringify(value)}`);
    if(value.ref !== 'dp_1' || value.paymentRef !== 'pi_1' || value.amount !== 5000 || value.currency !== 'usd' || value.reason !== 'fraudulent') return fail(`fields ${JSON.stringify(value)}`);
    const due = new Date(value.dueBy).getTime();
    if(Math.abs(due - inDays(5) * 1000) > 2000) return fail(`due ${value.dueBy}`);
    pass('');
  },

  'every Stripe status becomes one of kempo\'s five, and only two are open': async ({ pass, fail }) => {
    const expected = {
      needs_response: ['needs_response', true, false],
      warning_needs_response: ['needs_response', true, true],
      under_review: ['under_review', true, false],
      warning_under_review: ['under_review', true, true],
      won: ['won', false, false],
      lost: ['lost', false, false],
      warning_closed: ['closed', false, true],
      charge_refunded: ['closed', false, false],
    };
    for(const [status, [mapped, open, inquiry]] of Object.entries(expected)){
      const value = stripe.fromDispute(dispute({ status }));
      if(value.status !== mapped || value.open !== open || value.inquiry !== inquiry) return fail(`${status} became ${JSON.stringify([value.status, value.open, value.inquiry])}`);
    }
    if(stripe.fromDispute(dispute({ status: 'something_new' })).open !== true) return fail('a status nobody knows must be treated as needing a look');
    pass('');
  },

  'a payment given as a whole object, or missing details, does not break it': async ({ pass, fail }) => {
    const expanded = stripe.fromDispute(dispute({ payment_intent: { id: 'pi_9' } }));
    if(expanded.paymentRef !== 'pi_9') return fail(`expanded ${expanded.paymentRef}`);
    const bare = stripe.fromDispute(dispute({ payment_intent: null, evidence_details: undefined, reason: null, status: 'won' }));
    if(bare.paymentRef !== null || bare.dueBy !== null || bare.reason !== null || bare.hasEvidence !== false) return fail(`bare ${JSON.stringify(bare)}`);
    pass('');
  },

  'the dashboard link goes to the test or the live account': async ({ pass, fail }) => {
    if(stripe.disputeUrl({ ref: 'dp_1', livemode: false }) !== 'https://dashboard.stripe.com/test/disputes/dp_1') return fail('test link');
    if(stripe.disputeUrl({ ref: 'dp_2', livemode: true }) !== 'https://dashboard.stripe.com/disputes/dp_2') return fail('live link');
    pass('');
  },

  'the list puts what is open first, the soonest deadline at the top': async ({ pass, fail }) => {
    const [error, result] = await listDisputes({ provider: provider([
      dispute({ id: 'dp_lost', status: 'lost', created: 1_760_000_300, evidence_details: {}, payment_intent: null }),
      dispute({ id: 'dp_later', evidence_details: { due_by: inDays(10) }, payment_intent: null }),
      dispute({ id: 'dp_soon', evidence_details: { due_by: inDays(2) }, payment_intent: null }),
      dispute({ id: 'dp_review', status: 'under_review', evidence_details: {}, payment_intent: null }),
      dispute({ id: 'dp_won', status: 'won', created: 1_760_000_900, evidence_details: {}, payment_intent: null }),
    ]) });
    if(error) return fail(error.msg);
    const order = result.items.map(item => item.ref).join(' ');
    if(order !== 'dp_soon dp_later dp_review dp_won dp_lost') return fail(`order ${order}`);
    if(result.openCount !== 3 || result.total !== 5) return fail(`counts ${result.openCount}/${result.total}`);
    pass('');
  },

  'the filter keeps the open ones or the closed ones': async ({ pass, fail }) => {
    const stand = provider([dispute({ id: 'dp_a', payment_intent: null }), dispute({ id: 'dp_b', status: 'won', payment_intent: null })]);
    const [, open] = await listDisputes({ filter: 'open', provider: stand });
    const [, closed] = await listDisputes({ filter: 'closed', provider: stand });
    const [, all] = await listDisputes({ provider: stand });
    if(open.items.map(item => item.ref).join() !== 'dp_a' || closed.items.map(item => item.ref).join() !== 'dp_b' || all.items.length !== 2) return fail('filtering');
    if(open.openCount !== 1) return fail('the open count is of everything, whatever is shown');
    pass('');
  },

  'each dispute carries the link to answer it, and the payment it is about when this site made it': async ({ pass, fail }) => {
    const [, payment] = await insertPayment({
      provider: 'stripe', providerRef: 'pi_known', status: 'succeeded', amount: 5000, amountCaptured: 5000, currency: 'usd',
      owner: 'kempo-commerce', reference: 'ord_1004', description: 'Order #1004',
    });
    try {
      const [error, result] = await listDisputes({ provider: provider([
        dispute({ id: 'dp_mine', payment_intent: 'pi_known' }),
        dispute({ id: 'dp_other', payment_intent: 'pi_somewhere_else' }),
      ]) });
      if(error) return fail(error.msg);
      const mine = result.items.find(item => item.ref === 'dp_mine');
      const other = result.items.find(item => item.ref === 'dp_other');
      if(mine.payment?.id !== payment.id || mine.payment.description !== 'Order #1004' || mine.payment.reference !== 'ord_1004') return fail(`mine ${JSON.stringify(mine.payment)}`);
      if(other.payment !== null) return fail('a dispute about a payment this site did not record has no payment');
      if(mine.dashboardUrl !== 'https://dashboard.stripe.com/test/disputes/dp_mine') return fail(`link ${mine.dashboardUrl}`);
      pass('');
    } finally {
      await db.delete(kempoPayment).where(eq(kempoPayment.id, payment.id));
    }
  },

  'a provider that cannot list disputes says so, and the processor\'s own error is passed on': async ({ pass, fail }) => {
    const [unsupported] = await listDisputes({ provider: { name: 'x', label: 'Other' } });
    if(unsupported?.code !== 501 || !/Other/.test(unsupported.msg)) return fail(`unsupported ${JSON.stringify(unsupported)}`);
    const [refused] = await listDisputes({ provider: { name: 'x', label: 'Other', listDisputes: async () => [{ code: 409, msg: 'Stripe is not connected yet' }, null] } });
    if(refused?.code !== 409) return fail(`refused ${JSON.stringify(refused)}`);
    pass('');
  },
};

void newId;

export default databaseReachable ? tests : { 'disputes (SKIPPED)': async ({ pass }) => pass(`skipped: ${skipReason}`) };
