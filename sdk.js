/*
  Server-side entry point — what another extension imports to take money.

  This is the interface the board item calls for: a consumer (kempo-commerce's checkout today, a
  subscriptions extension later) creates, captures and refunds payments through these functions and
  never learns which processor is configured. Swapping Stripe for something else is a settings
  change, not a change to anything that called in here.

  ```js
  import { createPayment } from 'kempo-payments/sdk';

  const [error, { payment, clientSecret }] = await createPayment({
    amount: 4999,                 // always minor units — 4999 is $49.99
    currency: 'usd',
    owner: 'kempo-commerce',      // who is asking
    reference: order.id,          // their id for what is being paid for
    userId: user?.id,             // null for a guest
    customerEmail: order.email,
    description: `Order ${order.number}`,
  });
  ```

  Then hand `clientSecret` to the browser and mount `<k-pay-form>` with it. Do not wait for the
  browser to report back — listen for the `payment:succeeded` hook, which is fired from the
  processor's webhook and arrives whether or not that browser is still open.

  As in kempo's other extensions these are the *data* operations, with no permission checks of
  their own. The routes under public/api enforce who may do what; anything calling in here is
  server-side code that has already decided it is allowed.
*/

export { createPayment } from './server/utils/payments/create.js';
export { capturePayment, cancelPayment, refundPayment, getClientSecret } from './server/utils/payments/actions.js';
export { getPayment, getPaymentByRef, paymentsForReference, listPayments, listRefunds, summary } from './server/utils/payments/store.js';
export { syncPayment, EVENTS } from './server/utils/payments/sync.js';
export { receiveWebhook, listEvents } from './server/utils/webhooks/receive.js';

export { STATUSES, FINAL, isStatus, isFinal, isAwaitingCustomer, canCapture, canCancel, refundableAmount } from './server/utils/payments/statuses.js';
export { decimalsFor, formatAmount, fromMinor, isValidAmount, isValidCurrency, normaliseCurrency, toMinor } from './server/utils/money/currencies.js';

export { readConfig, CAPTURE_METHODS, DEFAULTS, OWNER } from './server/utils/config/settings.js';
export { activeProvider, getProvider, listProviders, providerForPayment } from './server/providers/index.js';
