/*
  The status vocabulary every provider maps onto, so that nothing outside server/providers/ ever
  has to know whose words it is reading.

  These happen to be Stripe's names, which is not laziness — they are the clearest description of
  the states a card payment actually passes through, and a second processor with fewer states maps
  into a subset rather than needing new ones. What matters is that the mapping lives in the
  provider module and this list is the only thing the rest of the extension matches against.
*/
export const STATUSES = [
  'requires_payment_method',  // started; nobody has entered a card yet, or the last one was declined
  'requires_confirmation',    // a card is attached, waiting to be submitted
  'requires_action',          // the bank wants the customer to do something — 3-D Secure, usually
  'processing',               // submitted; the processor has not finished
  'requires_capture',         // authorised only. The money is held, not taken. Capture or it expires
  'succeeded',                // taken
  'canceled',                 // abandoned or released before capture
  'failed',                   // the processor gave up on it
];

export const isStatus = status => STATUSES.includes(status);

/*
  Nothing more will happen to a payment in one of these states without somebody starting a new one.
  Refunds are not a status change — a fully refunded payment is still `succeeded`, with
  `amountRefunded === amountCaptured`, because the charge did happen and the money did move twice.
*/
export const FINAL = new Set(['succeeded', 'canceled', 'failed']);

export const isFinal = status => FINAL.has(status);

/*
  A payment still expecting something from the customer's browser. The distinction the checkout UI
  cares about: these are the states where showing the payment form again is the right thing to do,
  and every other state is one where it is not.
*/
export const AWAITING_CUSTOMER = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);

export const isAwaitingCustomer = status => AWAITING_CUSTOMER.has(status);

export const canCapture = payment =>
  payment?.captureMethod === 'manual' && payment?.status === 'requires_capture';

export const canCancel = payment =>
  !isFinal(payment?.status);

/*
  What is left to give back. A payment that was only authorised has nothing to refund — releasing
  the hold is a cancel, not a refund, and offering the wrong one produces a processor error the
  person reading it cannot act on.
*/
export const refundableAmount = payment => {
  if(payment?.status !== 'succeeded') return 0;
  return Math.max(0, (payment.amountCaptured || 0) - (payment.amountRefunded || 0));
};
