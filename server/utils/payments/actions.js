import { triggerHook } from 'kempo/server/sdk.js';
import { providerForPayment } from '../../providers/index.js';
import { formatAmount } from '../money/currencies.js';
import { hasNulByte } from './text.js';
import { canCancel, canCapture, refundableAmount } from './statuses.js';
import { getPayment } from './store.js';
import { applyProviderState, applyRefunds } from './sync.js';

/*
  The three things somebody does to a payment after it exists: take the money that was held,
  release it, or give it back.

  Each of them goes back to the processor the payment was originally made through, not the one the
  site is configured to use now. Money that is sitting at Stripe is not refundable by PayPal, and a
  site that switched processors last month still has last month's payments to answer for.
*/

/*
  Turns an authorisation into a charge.

  Only meaningful for a manual-capture payment. An automatic one was already charged when the
  customer confirmed it, and asking the processor to capture it returns an error whose wording
  ("payment_intent_unexpected_state") explains nothing to the person who pressed the button — so
  the refusal happens here, in words.
*/
export const capturePayment = async (id, { amount } = {}) => {
  const [loadError, payment] = await getPayment(id);
  if(loadError) return [loadError, null];

  if(!canCapture(payment)){
    return [{
      code: 409,
      msg: payment.captureMethod === 'automatic'
        ? 'This payment was charged when the customer confirmed it — there is nothing left to capture'
        : `A payment can only be captured while it is awaiting capture, and this one is ${payment.status.replace(/_/g, ' ')}`,
    }, null];
  }

  /*
    Capturing less than was authorised is allowed and normal — an order that shipped short. More is
    not: the hold is for a fixed amount and the customer never agreed to anything above it.
  */
  if(amount !== undefined && amount !== null){
    if(!Number.isInteger(amount) || amount <= 0){
      return [{ code: 400, msg: 'A capture amount must be a whole number of the currency’s smallest unit' }, null];
    }
    if(amount > payment.amount){
      return [{ code: 400, msg: 'Cannot capture more than was authorised' }, null];
    }
  }

  const [providerError, provider] = providerForPayment(payment);
  if(providerError) return [providerError, null];

  const [captureError, state] = await provider.capture(payment.providerRef, { amount, connectedAccount: payment.connectedAccount });
  if(captureError) return [captureError, null];

  return applyProviderState(payment, state);
};

/*
  Releases a payment that has not been taken.

  Not a refund: nothing has moved, so nothing comes back. The hold on the customer's card
  disappears — though their bank may take a few days to stop showing it, which is worth saying on
  screen because it is the single most common "you charged me twice" support ticket.
*/
export const cancelPayment = async id => {
  const [loadError, payment] = await getPayment(id);
  if(loadError) return [loadError, null];

  if(!canCancel(payment)){
    return [{ code: 409, msg: `This payment is already ${payment.status.replace(/_/g, ' ')}` }, null];
  }

  const [providerError, provider] = providerForPayment(payment);
  if(providerError) return [providerError, null];

  const [cancelError, state] = await provider.cancel(payment.providerRef, { connectedAccount: payment.connectedAccount });
  if(cancelError) return [cancelError, null];

  return applyProviderState(payment, state);
};

/*
  What a refund of this payment is sent to the processor with, beyond the amount and reason.

  The connected account comes from the row, never the caller — the refund cannot reach the money
  without it. `refundApplicationFee` only applies to a payment that took a fee on a connected
  account, and defaults to **true** there: refunding a tip gives back the site's cut of it too, in
  proportion. Stripe's own default is the opposite (the site keeps its fee and the recipient pays
  the whole refund), which is why it is always sent explicitly. Pass `false` to keep the fee.

  Exported so the decision can be tested without a processor.
*/
export const refundOptionsFor = (payment, { refundApplicationFee } = {}) => {
  if(!payment?.connectedAccount) return {};
  if(!(payment.applicationFee > 0)) return { connectedAccount: payment.connectedAccount };
  return {
    connectedAccount: payment.connectedAccount,
    refundApplicationFee: typeof refundApplicationFee === 'boolean' ? refundApplicationFee : true,
  };
};

/*
  Gives money back, in full or in part.

  Omitting the amount refunds everything still outstanding, which is what a "Refund" button should
  do and what most callers want. Passing one refunds exactly that much, and several partial refunds
  can be issued until the outstanding amount reaches zero.

  For a payment on a connected account, `refundApplicationFee` decides whether the site's fee is
  returned with it — see `refundOptionsFor`.

  `idempotencyKey`, when given, is sent to the processor with the refund, so a caller that retries
  after a timeout gets the refund it already made rather than a second one. Optional, so every
  existing caller is unchanged.
*/
export const refundPayment = async (id, { amount, reason, issuedBy, refundApplicationFee, idempotencyKey } = {}) => {
  // Checked before the processor is asked: once it has refunded, a failed insert is a refund nobody recorded.
  if(hasNulByte(reason, issuedBy)){
    return [{ code: 400, msg: 'A refund reason cannot contain null characters' }, null];
  }
  if(idempotencyKey !== undefined && idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 255 || hasNulByte(idempotencyKey))){
    return [{ code: 400, msg: 'An idempotency key is a short piece of text' }, null];
  }
  if(refundApplicationFee !== undefined && refundApplicationFee !== null && typeof refundApplicationFee !== 'boolean'){
    return [{ code: 400, msg: 'Whether to refund the application fee is true or false' }, null];
  }

  const [loadError, payment] = await getPayment(id);
  if(loadError) return [loadError, null];

  const outstanding = refundableAmount(payment);

  if(!outstanding){
    return [{
      code: 409,
      msg: payment.status === 'requires_capture'
        ? 'Nothing has been charged yet — cancel the payment to release the hold instead'
        : payment.status === 'succeeded'
          ? 'This payment has already been refunded in full'
          : `A payment can only be refunded once it has succeeded, and this one is ${payment.status.replace(/_/g, ' ')}`,
    }, null];
  }

  const requested = amount === undefined || amount === null ? outstanding : amount;

  if(!Number.isInteger(requested) || requested <= 0){
    return [{ code: 400, msg: 'A refund amount must be a whole number of the currency’s smallest unit' }, null];
  }
  if(requested > outstanding){
    return [{ code: 400, msg: `Only ${formatAmount(outstanding, payment.currency)} is left to refund on this payment` }, null];
  }

  /*
    The extension that took the payment gets a say before any money moves. `payment:refunding` is a
    guard: a handler that throws `{ code, msg }` refuses the refund with that error, and the
    processor is never asked. kempo-credits uses it so a payment for credits that have since been
    spent cannot be refunded from here. A refund made in the processor's own dashboard never passes
    through this, so a listener still has to cope with `payment:refunded` arriving regardless.
  */
  try {
    await triggerHook('payment:refunding', { payment, amount: requested, reason: reason || null, issuedBy: issuedBy || null }, { bail: true });
  } catch(error) {
    return [{ code: error?.code || 409, msg: error?.msg || error?.message || 'The refund was refused' }, null];
  }

  const [providerError, provider] = providerForPayment(payment);
  if(providerError) return [providerError, null];

  const [refundError, refund] = await provider.refund(payment.providerRef, {
    amount: requested,
    reason,
    ...refundOptionsFor(payment, { refundApplicationFee: refundApplicationFee ?? undefined }),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  if(refundError) return [refundError, null];

  return applyRefunds(payment, [refund], { issuedBy });
};

/*
  The client secret for a payment that is already in flight, fetched fresh from the processor.

  A checkout page that was reloaded, or a customer coming back to finish paying, needs this to
  mount the payment form again — and it is deliberately not something the payment row carries
  around, so it is here rather than on every read.
*/
export const getClientSecret = async id => {
  const [loadError, payment] = await getPayment(id);
  if(loadError) return [loadError, null];

  const [providerError, provider] = providerForPayment(payment);
  if(providerError) return [providerError, null];

  const [fetchError, state] = await provider.retrieveIntent(payment.providerRef, { connectedAccount: payment.connectedAccount });
  if(fetchError) return [fetchError, null];

  /*
    The connected account travels with the secret: a payment form cannot confirm an intent that
    lives on another account unless it is told which one.
  */
  return [null, { payment, clientSecret: state.clientSecret, connectedAccount: payment.connectedAccount || null }];
};
