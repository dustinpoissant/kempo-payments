import { hasNulByte } from '../server/utils/payments/text.js';
import { createPayment } from '../server/utils/payments/create.js';
import { listPayments } from '../server/utils/payments/store.js';
import { refundPayment } from '../server/utils/payments/actions.js';

/*
  A NUL byte cannot be stored by Postgres, in text or in jsonb. Before this check it reached the
  insert: a payment created a processor intent, failed to record it, cancelled it again and returned
  a 500, and a list filter carrying one was a 500 too. Both are the caller's mistake, so both are a
  400 — and neither reaches the database or a provider. None of these need either to be reachable.
*/

export default {
  'hasNulByte finds one wherever it hides, and nothing else': async ({ pass, fail }) => {
    for(const value of ['a\u0000b', { note: 'x\u0000' }, { deep: { list: ['ok', 'no\u0000'] } }, ['\u0000']]){
      if(!hasNulByte(value)) return fail(`missed one in ${JSON.stringify(value)}`);
    }
    if(!hasNulByte('fine', null, 'a\u0000')) return fail('missed one in a later argument');

    for(const value of [undefined, null, '', 'plain', '\\u0000', 'a\\u0000b', { note: 'ok', n: 1, ok: true }, 0]){
      if(hasNulByte(value)) return fail(`${JSON.stringify(value)} was flagged and has no NUL byte in it`);
    }
    pass('strings, nested objects and arrays are searched; an escaped backslash-u0000 is not a NUL');
  },

  'createPayment refuses one in any caller-supplied field, before contacting a provider': async ({ pass, fail }) => {
    const fields = ['description', 'owner', 'reference', 'userId', 'customerEmail'];

    for(const field of fields){
      const [error, result] = await createPayment({ amount: 1000, currency: 'usd', [field]: 'a\u0000b' });
      if(result) return fail(`${field} with a NUL byte produced a payment`);
      if(error?.code !== 400) return fail(`${field} got ${error?.code} (${error?.msg}) instead of a 400`);
    }

    const [error] = await createPayment({ amount: 1000, currency: 'usd', metadata: { order: { note: 'x\u0000' } } });
    if(error?.code !== 400) return fail(`nested metadata got ${error?.code} (${error?.msg}) instead of a 400`);

    pass(`${fields.length} fields and nested metadata refused with a 400`);
  },

  /*
    The expensive one. A refund reason with a NUL byte reached Stripe, which refunded, and then
    could not be inserted — a 500 for a refund that had happened, which a retry would repeat. So it
    has to be refused before the processor is asked, which is why no payment needs to exist here.
  */
  'refundPayment refuses one in the reason before anything is refunded': async ({ pass, fail }) => {
    for(const options of [{ reason: 'a\u0000b' }, { issuedBy: 'a\u0000b' }]){
      const [error, result] = await refundPayment('any-id', { amount: 100, ...options });
      if(result) return fail(`${JSON.stringify(options)} produced a refund`);
      if(error?.code !== 400) return fail(`${JSON.stringify(options)} got ${error?.code} (${error?.msg}) instead of a 400 — it was not refused up front`);
    }
    pass('a reason or issuer with a NUL byte is a 400 before the payment is even loaded');
  },

  'listPayments refuses one in any filter': async ({ pass, fail }) => {
    for(const filter of ['status', 'provider', 'owner', 'reference', 'userId']){
      const [error, result] = await listPayments({ [filter]: 'a\u0000b' });
      if(result) return fail(`${filter} with a NUL byte was run as a query`);
      if(error?.code !== 400) return fail(`${filter} got ${error?.code} (${error?.msg}) instead of a 400`);
    }

    const [error] = await listPayments({ status: ['succeeded', 'a\u0000b'] });
    if(error?.code !== 400) return fail(`a status list got ${error?.code} instead of a 400`);

    pass('every filter, including a list of statuses, refused with a 400');
  },
};
