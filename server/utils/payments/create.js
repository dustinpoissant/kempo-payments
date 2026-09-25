import { activeProvider } from '../../providers/index.js';
import { isValidAmount, isValidCurrency, normaliseCurrency } from '../money/currencies.js';
import { CAPTURE_METHODS, parseCaptureMethod, readConfig } from '../config/settings.js';
import { insertPayment, newId } from './store.js';
import { firePaymentCreated } from './sync.js';
import { hasNulByte } from './text.js';

/*
  Starting a payment: ask the processor for an intent, write down what it said, hand back the one
  piece the browser needs.

  The client secret is returned and never stored. It is short-lived, it is derivable from the
  processor at any time, and a copy in the database is one more place it can leak from for no
  benefit at all — `getClientSecret` re-fetches it when a page needs it again.
*/

export const createPayment = async ({
  amount,
  currency,
  description = null,
  metadata = null,
  captureMethod = null,
  owner = null,
  reference = null,
  userId = null,
  customerEmail = null,
} = {}) => {
  if(hasNulByte(description, metadata, owner, reference, userId, customerEmail)){
    return [{ code: 400, msg: 'Payment details cannot contain null characters' }, null];
  }

  /*
    A capture method the caller actually passed is validated, never guessed at — and before any
    provider is contacted. Falling back to the site default here would turn a mistyped "hold this
    card" into "charge this card", which is the one direction this parameter must never fail in.
  */
  let method = null;
  if(captureMethod){
    method = parseCaptureMethod(captureMethod);
    if(!method) return [{ code: 400, msg: `Capture method must be one of: ${CAPTURE_METHODS.join(', ')}` }, null];
  }

  const config = await readConfig();
  method ??= config.captureMethod;
  const code = normaliseCurrency(currency || config.currency);

  /*
    Validated here rather than left to the processor. A caller that passes 12.99 instead of 1299 is
    charging a hundredth of what it meant to, and Stripe would take that instruction happily — it
    is a perfectly valid amount, just not the one anybody intended. Refusing a non-integer is the
    only place that mistake can be caught.
  */
  if(!isValidCurrency(code)){
    return [{ code: 400, msg: `"${currency}" is not a currency code` }, null];
  }
  if(!Number.isInteger(amount)){
    return [{ code: 400, msg: 'Amount must be a whole number of the currency’s smallest unit — 1299 for $12.99' }, null];
  }
  if(!isValidAmount(amount, code)){
    return [{ code: 400, msg: `${amount} is not a chargeable amount in ${code.toUpperCase()}` }, null];
  }

  const [providerError, provider] = await activeProvider();
  if(providerError) return [providerError, null];

  /*
    Our id is generated before the intent and sent as the idempotency key, so a request that times
    out and is retried by the caller lands on the same intent instead of a second one. Two intents
    for one order is two authorisation holds on a real customer's card.
  */
  const id = newId();

  const [intentError, intent] = await provider.createIntent({
    amount,
    currency: code,
    description,
    metadata: { ...(metadata || {}), kempoPaymentId: id, ...(owner ? { kempoOwner: owner } : {}), ...(reference ? { kempoReference: reference } : {}) },
    captureMethod: method,
    customerEmail,
    idempotencyKey: id,
  });
  if(intentError) return [intentError, null];

  const [insertError, payment] = await insertPayment({
    id,
    provider: provider.name,
    providerRef: intent.ref,
    livemode: intent.livemode,
    status: intent.status,
    captureMethod: method,
    amount,
    amountCaptured: intent.amountCaptured,
    currency: code,
    owner,
    reference,
    description,
    metadata,
    userId,
    customerEmail,
  });

  /*
    An intent that exists at the processor with no row here is invisible: nothing would ever
    capture it, refund it or release the hold. Cancelling it is best-effort — if that fails too,
    the intent expires on its own, and the id is logged so it can be found by hand in the meantime.
  */
  if(insertError){
    const [cancelError] = await provider.cancel(intent.ref);
    if(cancelError) console.error(`[kempo-payments] Orphaned ${provider.name} intent ${intent.ref} — could not be recorded or cancelled`);
    return [insertError, null];
  }

  await firePaymentCreated(payment);

  return [null, { payment, clientSecret: intent.clientSecret }];
};
