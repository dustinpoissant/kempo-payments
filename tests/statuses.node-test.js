import { STATUSES, isFinal, isAwaitingCustomer, canCapture, canCancel, refundableAmount } from '../server/utils/payments/statuses.js';
import * as stripe from '../server/providers/stripe.js';

/*
  The status vocabulary, and the questions the rest of the extension asks about it.

  `refundableAmount` gets the most attention here because it is the one that decides how much money
  leaves the merchant's account. Everything else on this screen is a label; that one is arithmetic
  with a bank behind it.
*/

const payment = overrides => ({
  status: 'succeeded',
  captureMethod: 'automatic',
  amount: 5000,
  amountCaptured: 5000,
  amountRefunded: 0,
  ...overrides,
});

export default {
  'every status a provider can produce is one the vocabulary declares': async ({ pass, fail }) => {
    /*
      The mapping table inside the provider is what keeps Stripe's words out of the rest of the
      extension. A status it emits that is not on this list would be written straight to a row and
      then matched against by nothing.
    */
    const intents = [
      { id: 'pi_1', status: 'requires_payment_method', amount: 100, currency: 'usd', capture_method: 'automatic' },
      { id: 'pi_2', status: 'requires_confirmation', amount: 100, currency: 'usd', capture_method: 'automatic' },
      { id: 'pi_3', status: 'requires_action', amount: 100, currency: 'usd', capture_method: 'automatic' },
      { id: 'pi_4', status: 'processing', amount: 100, currency: 'usd', capture_method: 'automatic' },
      { id: 'pi_5', status: 'requires_capture', amount: 100, currency: 'usd', capture_method: 'manual' },
      { id: 'pi_6', status: 'succeeded', amount: 100, currency: 'usd', capture_method: 'automatic' },
      { id: 'pi_7', status: 'canceled', amount: 100, currency: 'usd', capture_method: 'automatic' },
      { id: 'pi_8', status: 'something_new', amount: 100, currency: 'usd', capture_method: 'automatic' },
    ];

    for(const intent of intents){
      const mapped = stripe.fromIntent(intent).status;
      if(!STATUSES.includes(mapped)) return fail(`${intent.status} mapped to ${mapped}, which is not a kempo status`);
    }
    pass('including an unrecognised one, which lands on a real status rather than passing through');
  },

  'a payment that has ended is final; one in flight is not': async ({ pass, fail }) => {
    for(const status of ['succeeded', 'canceled', 'failed']){
      if(!isFinal(status)) return fail(`${status} should be final`);
    }
    for(const status of ['requires_payment_method', 'processing', 'requires_capture']){
      if(isFinal(status)) return fail(`${status} should not be final`);
    }
    pass('final states are the three nothing more happens to');
  },

  'the states where showing the payment form again is right': async ({ pass, fail }) => {
    for(const status of ['requires_payment_method', 'requires_confirmation', 'requires_action']){
      if(!isAwaitingCustomer(status)) return fail(`${status} is waiting on the customer`);
    }
    for(const status of ['processing', 'requires_capture', 'succeeded']){
      if(isAwaitingCustomer(status)) return fail(`${status} is not waiting on the customer`);
    }
    pass('only the three that need the customer to act');
  },

  'only a manual authorisation can be captured': async ({ pass, fail }) => {
    if(!canCapture(payment({ captureMethod: 'manual', status: 'requires_capture' }))){
      return fail('a manual payment awaiting capture is capturable');
    }
    if(canCapture(payment({ captureMethod: 'automatic', status: 'succeeded' }))){
      return fail('an automatic payment was already charged — there is nothing to capture');
    }
    if(canCapture(payment({ captureMethod: 'manual', status: 'processing' }))){
      return fail('a payment still processing has nothing held yet');
    }
    pass('capture is offered exactly where it means something');
  },

  'anything not yet finished can be cancelled': async ({ pass, fail }) => {
    if(!canCancel(payment({ status: 'requires_capture' }))) return fail('a hold can be released');
    if(canCancel(payment({ status: 'succeeded' }))) return fail('a completed payment is refunded, not cancelled');
    pass('cancel and refund do not overlap');
  },

  /*
    The distinction that matters most on this screen: a payment that was authorised but never
    captured has had no money taken, so there is nothing to give back. Offering a refund there
    produces a processor error whose wording explains nothing to whoever pressed the button.
  */
  'only money actually taken is refundable': async ({ pass, fail }) => {
    if(refundableAmount(payment()) !== 5000) return fail('a fully captured payment is fully refundable');
    if(refundableAmount(payment({ amountRefunded: 2000 })) !== 3000) return fail('a partial refund leaves the rest');
    if(refundableAmount(payment({ amountRefunded: 5000 })) !== 0) return fail('a fully refunded payment has nothing left');
    if(refundableAmount(payment({ status: 'requires_capture', amountCaptured: 0 })) !== 0){
      return fail('nothing was taken from an uncaptured authorisation');
    }
    if(refundableAmount(payment({ status: 'canceled', amountCaptured: 0 })) !== 0){
      return fail('a cancelled payment has nothing to refund');
    }
    pass('refundable is captured minus refunded, and only once succeeded');
  },

  /*
    A partial capture takes less than was authorised, and the difference is never charged. Refunding
    against the authorised amount rather than the captured one would try to return money the
    customer never paid.
  */
  'a partial capture is only refundable up to what was captured': async ({ pass, fail }) => {
    const partial = payment({ amount: 5000, amountCaptured: 3000 });
    if(refundableAmount(partial) !== 3000){
      return fail(`refundable was ${refundableAmount(partial)}, but only 3000 was ever taken`);
    }
    pass('the authorised amount is not the refundable amount');
  },
};
