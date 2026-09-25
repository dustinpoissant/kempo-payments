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

  const [captureError, state] = await provider.capture(payment.providerRef, { amount });
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

  const [cancelError, state] = await provider.cancel(payment.providerRef);
  if(cancelError) return [cancelError, null];

  return applyProviderState(payment, state);
};

/*
  Gives money back, in full or in part.

  Omitting the amount refunds everything still outstanding, which is what a "Refund" button should
  do and what most callers want. Passing one refunds exactly that much, and several partial refunds
  can be issued until the outstanding amount reaches zero.
*/
export const refundPayment = async (id, { amount, reason, issuedBy } = {}) => {
  // Checked before the processor is asked: once it has refunded, a failed insert is a refund nobody recorded.
  if(hasNulByte(reason, issuedBy)){
    return [{ code: 400, msg: 'A refund reason cannot contain null characters' }, null];
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

  const [providerError, provider] = providerForPayment(payment);
  if(providerError) return [providerError, null];

  const [refundError, refund] = await provider.refund(payment.providerRef, { amount: requested, reason });
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

  const [fetchError, state] = await provider.retrieveIntent(payment.providerRef);
  if(fetchError) return [fetchError, null];

  return [null, { payment, clientSecret: state.clientSecret }];
};
