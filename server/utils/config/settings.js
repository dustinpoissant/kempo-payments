import { getSetting } from 'kempo/server/sdk.js';
import { isValidCurrency, normaliseCurrency } from '../money/currencies.js';

/*
  Reading the settings, and validating them, in one place.

  Everything on the settings screen is editable, and two of the values decide how money is taken —
  a currency that is not a currency, or a capture method that is neither of the two that exist,
  must not reach a processor. So every value the rest of the extension sees has been through a
  `normalise*` below and is known-good, with a working default behind it rather than an error.

  Credentials are deliberately not here. Each provider module reads its own, because their names
  and number are the provider's business — see server/providers/stripe.js.
*/

export const OWNER = 'kempo-payments';

export const CAPTURE_METHODS = ['automatic', 'manual'];

export const DEFAULTS = {
  provider: 'stripe',
  currency: 'usd',
  captureMethod: 'automatic',
};

/*
  What a caller or a form actually typed, forgiving about case and stray spaces and nothing else.
  `null` means it is not one of the two — and a caller that was *handed* the value must refuse it
  rather than guess (see createPayment and the settings route), because "charge now" and "hold for
  later" are opposites: guessing wrong takes a customer's money when only a reservation was meant.
  Found by testing against Stripe, where every spelling except the exact lowercase `manual` —
  `Manual`, `MANUAL `, a typo, `hold` — quietly became an immediate charge.
*/
export const parseCaptureMethod = value => {
  // Strings only: coercing would read `["manual"]` out of a JSON body as "manual".
  if(typeof value !== 'string') return null;
  const method = value.trim().toLowerCase();
  return CAPTURE_METHODS.includes(method) ? method : null;
};

// Only for the stored site default, where the alternative to a fallback is no payments at all.
export const normaliseCaptureMethod = value => parseCaptureMethod(value) ?? DEFAULTS.captureMethod;

/*
  A bad currency falls back rather than throwing, but never silently in a place that matters:
  `createPayment` validates the currency it was actually handed and refuses an invalid one there.
  This fallback only covers the site-wide default, where the alternative is an extension that
  cannot take any payment at all until somebody fixes a typo.
*/
export const normaliseDefaultCurrency = value => {
  const currency = normaliseCurrency(value);
  return isValidCurrency(currency) ? currency : DEFAULTS.currency;
};

export const readConfig = async () => {
  const read = async (name, fallback) => {
    const [error, value] = await getSetting(OWNER, name, fallback);
    return error ? fallback : value;
  };

  const [provider, currency, captureMethod] = await Promise.all([
    read('provider', DEFAULTS.provider),
    read('currency', DEFAULTS.currency),
    read('capture_method', DEFAULTS.captureMethod),
  ]);

  return {
    provider: String(provider || DEFAULTS.provider),
    currency: normaliseDefaultCurrency(currency),
    captureMethod: normaliseCaptureMethod(captureMethod),
  };
};
