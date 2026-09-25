import { triggerHook } from 'kempo/server/sdk.js';
import { providerForPayment } from '../../providers/index.js';
import { getPayment, recordRefund, refundedTotal, updatePayment } from './store.js';
import { stripNulBytes } from './text.js';

/*
  Where a payment's row is brought into line with what the processor says, and where the hooks
  other extensions listen to are fired.

  Everything that can change a payment — the admin capturing one, a webhook arriving, a page asking
  for the current state — funnels through here rather than writing the row itself. That is what
  makes "did the order get fulfilled?" answerable: there is exactly one place a payment can become
  `succeeded`, and it is the same place that fires `payment:succeeded`.

  Hooks fire only on a real transition. A processor that redelivers the same event ten times, or an
  admin screen that polls, produces no changes and therefore no hooks — which matters because the
  handler on the other end sends an email, issues a licence key or ships a box.
*/

/*
  The events this extension fires. Consumers register handlers for them in their own
  kempo-config.json — see the README.

  `payment:succeeded` is the one to hang fulfilment off. It fires once per payment, when the money
  has actually been taken, whether that was automatic or a capture somebody performed by hand.
*/
export const EVENTS = [
  'payment:created',     // { payment } — an attempt has been started; no money has moved
  'payment:authorized',  // { payment } — held on the customer's card, waiting to be captured
  'payment:succeeded',   // { payment } — taken
  'payment:failed',      // { payment, error } — the processor refused it
  'payment:canceled',    // { payment } — abandoned, or the hold released
  'payment:refunded',    // { payment, refund } — some or all of it given back
  'payment:disputed',    // { payment, disputed, reason } — a chargeback opened, or closed
];

const fire = async (event, data) => {
  const [error] = await triggerHook(event, data);
  if(error) console.warn(`[kempo-payments] Could not fire ${event}: ${error.msg}`);
};

/*
  Persists a provider's view of a payment and fires whatever that change means.

  `state` is the normalised shape a provider module returns. Fields it leaves undefined are fields
  the provider had no answer for on this call, and they are left alone rather than zeroed — an
  unexpanded charge reports no refund total, and writing 0 over a real one would erase a refund
  from the record without erasing it from the customer's statement.
*/
export const applyProviderState = async (payment, state, { failed = false } = {}) => {
  const changes = {};

  if(state.status && state.status !== payment.status) changes.status = state.status;
  if(Number.isInteger(state.amountCaptured) && state.amountCaptured !== payment.amountCaptured){
    changes.amountCaptured = state.amountCaptured;
  }
  if(Number.isInteger(state.amountRefunded) && state.amountRefunded !== payment.amountRefunded){
    changes.amountRefunded = state.amountRefunded;
  }
  if(typeof state.livemode === 'boolean' && state.livemode !== payment.livemode) changes.livemode = state.livemode;
  if(state.captureMethod && state.captureMethod !== payment.captureMethod) changes.captureMethod = state.captureMethod;

  /*
    A decline message is kept until something works, then cleared. A payment that eventually
    succeeded on the third card is not a failed payment, and leaving the first card's message on it
    makes every screen showing the payment say otherwise.
  */
  const nextError = stripNulBytes(failed ? (state.lastError || 'The payment failed') : state.lastError ?? null);
  if((nextError || null) !== (payment.lastError || null)) changes.lastError = nextError || null;

  if(!Object.keys(changes).length) return [null, { payment, changed: false }];

  const [error, updated] = await updatePayment(payment.id, changes);
  if(error) return [error, null];

  if(failed) await fire('payment:failed', { payment: updated, error: updated.lastError });

  if(changes.status){
    if(changes.status === 'succeeded') await fire('payment:succeeded', { payment: updated });
    if(changes.status === 'requires_capture') await fire('payment:authorized', { payment: updated });
    if(changes.status === 'canceled') await fire('payment:canceled', { payment: updated });
  }

  return [null, { payment: updated, changed: true }];
};

/*
  Records refunds the provider reported and rolls the payment's refunded total up from them.

  The total is recomputed from the refund rows rather than added to, so an admin refund and the
  webhook that reports the same refund a second later cannot between them claim twice the money was
  returned.
*/
export const applyRefunds = async (payment, refunds, { issuedBy } = {}) => {
  const recorded = [];

  for(const refund of refunds || []){
    if(!refund?.ref) continue;

    const [error, row] = await recordRefund({
      paymentId: payment.id,
      provider: payment.provider,
      providerRef: refund.ref,
      amount: refund.amount,
      currency: refund.currency || payment.currency,
      status: refund.status || 'pending',
      reason: stripNulBytes(refund.reason),
      issuedBy,
    });
    if(error) return [error, null];
    recorded.push(row);
  }

  const [totalError, total] = await refundedTotal(payment.id);
  if(totalError) return [totalError, null];

  let current = payment;
  if(total !== payment.amountRefunded){
    const [error, updated] = await updatePayment(payment.id, { amountRefunded: total });
    if(error) return [error, null];
    current = updated;

    for(const refund of recorded){
      await fire('payment:refunded', { payment: current, refund });
    }
  }

  return [null, { payment: current, refunds: recorded }];
};

export const applyDispute = async (payment, { disputed, reason }) => {
  if(payment.disputed === disputed) return [null, { payment, changed: false }];

  const [error, updated] = await updatePayment(payment.id, { disputed });
  if(error) return [error, null];

  await fire('payment:disputed', { payment: updated, disputed, reason: reason || null });
  return [null, { payment: updated, changed: true }];
};

export const firePaymentCreated = payment => fire('payment:created', { payment });

/*
  Asks the processor what it thinks and writes the answer down.

  The webhook is the authority in normal operation — this is for the cases where it is not: a
  webhook that has not arrived yet, a site whose signing secret was wrong for a week, a payment
  somebody is looking at right now and wants the truth about. Safe to call as often as wanted;
  it only writes when something actually differs.
*/
export const syncPayment = async id => {
  const [loadError, payment] = await getPayment(id);
  if(loadError) return [loadError, null];

  const [providerError, provider] = providerForPayment(payment);
  if(providerError) return [providerError, null];

  const [fetchError, state] = await provider.retrieveIntent(payment.providerRef);
  if(fetchError) return [fetchError, null];

  if(!provider.listRefunds) return applyProviderState(payment, state);

  /*
    Refunds are reconciled from the refunds themselves, not from the charge's running total. Both
    would agree, but the total alone leaves a refund with no row, and the next refund's recompute
    from rows would then quietly erase it. The total is also held back from `applyProviderState`
    so that `applyRefunds` sees the change and fires `payment:refunded` for it.
  */
  const [refundsError, refunds] = await provider.listRefunds(payment.providerRef);
  if(refundsError) return [refundsError, null];

  const [stateError, applied] = await applyProviderState(payment, { ...state, amountRefunded: undefined });
  if(stateError) return [stateError, null];

  const [applyError, result] = await applyRefunds(applied.payment, refunds);
  if(applyError) return [applyError, null];

  return [null, { payment: result.payment, changed: applied.changed || result.payment.amountRefunded !== payment.amountRefunded }];
};
