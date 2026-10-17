import { activeProvider } from '../../providers/index.js';
import { getPaymentByRef } from '../payments/store.js';

/*
  The disputes (chargebacks) the processor has open or has closed, each tied to the payment it is
  about when this site made it.

  Read from the processor every time rather than kept in a table: the processor is where a dispute
  is answered and where its status changes, so a copy here would only ever be a stale picture of it.
  What this site keeps is the yes/no flag on the payment, set by the webhook, which is what other
  extensions react to.

  `filter` is `open` (needs an answer or is being decided), `closed`, or `all`. Open ones come first,
  the soonest deadline at the top, because the one that matters is the one about to run out.
*/

const sortDisputes = (a, b) => {
  if(a.open !== b.open) return a.open ? -1 : 1;
  if(a.open){
    if(a.dueBy && b.dueBy) return a.dueBy.localeCompare(b.dueBy);
    if(a.dueBy || b.dueBy) return a.dueBy ? -1 : 1;
  }
  return b.created.localeCompare(a.created);
};

export const listDisputes = async ({ filter = 'all', provider } = {}) => {
  let active = provider;
  if(!active){
    const [error, found] = await activeProvider();
    if(error) return [error, null];
    active = found;
  }
  if(typeof active.listDisputes !== 'function') return [{ code: 501, msg: `${active.label} cannot list disputes here` }, null];

  const [error, disputes] = await active.listDisputes();
  if(error) return [error, null];

  const items = await Promise.all(disputes.map(async dispute => {
    const [, payment] = dispute.paymentRef ? await getPaymentByRef(active.name, dispute.paymentRef) : [null, null];
    return {
      ...dispute,
      dashboardUrl: active.disputeUrl?.(dispute) ?? null,
      payment: payment ? {
        id: payment.id, owner: payment.owner, reference: payment.reference, description: payment.description,
        amount: payment.amount, currency: payment.currency,
      } : null,
    };
  }));

  const shown = items.filter(item => filter === 'open' ? item.open : filter === 'closed' ? !item.open : true).sort(sortDisputes);
  return [null, { items: shown, openCount: items.filter(item => item.open).length, total: items.length }];
};
