/*
  Money is integers here, always — the amount in the currency's smallest unit. $12.99 is 1299.

  This module exists because "smallest unit" is not two decimal places everywhere, and code that
  assumes it is will be out by a factor of a hundred in Japan and by ten in Kuwait. Those are not
  display bugs; they are charging the wrong amount.
*/

export const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

/*
  Currencies whose minor unit is a thousandth. Stripe additionally requires the amount to be a
  whole number of hundredths — a trailing zero — which `isValidAmount` enforces rather than
  silently rounding somebody's total.
*/
export const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

export const decimalsFor = currency => {
  const code = normaliseCurrency(currency);
  if(ZERO_DECIMAL.has(code)) return 0;
  if(THREE_DECIMAL.has(code)) return 3;
  return 2;
};

/*
  ISO 4217 is three letters. Anything else is refused rather than coerced: a currency of "dollars"
  reaching a processor is a rejected charge at best, and a charge in the wrong currency at worst.
*/
export const normaliseCurrency = currency => String(currency ?? '').trim().toLowerCase();

export const isValidCurrency = currency => /^[a-z]{3}$/.test(normaliseCurrency(currency));

export const isValidAmount = (amount, currency) => {
  if(!Number.isInteger(amount) || amount <= 0) return false;
  if(THREE_DECIMAL.has(normaliseCurrency(currency)) && amount % 10 !== 0) return false;
  return true;
};

/*
  Major units in, minor units out — for a caller that genuinely has "12.99" and not 1299, such as
  an admin typing a refund amount into a box. Rounds rather than truncates, because 12.99 * 100 is
  1298.9999999999998 in floating point and truncation would quietly short the merchant a cent.
*/
export const toMinor = (major, currency) => {
  const amount = Number(major);
  if(!Number.isFinite(amount)) return null;
  return Math.round(amount * 10 ** decimalsFor(currency));
};

export const fromMinor = (minor, currency) => Number(minor) / 10 ** decimalsFor(currency);

/*
  For display only. Falls back to a bare number with the code appended if the runtime has no data
  for the currency, which is better than throwing on a screen whose job is to show a total.
*/
export const formatAmount = (minor, currency, locale = 'en-US') => {
  const code = normaliseCurrency(currency);
  const value = fromMinor(minor, code);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code.toUpperCase() }).format(value);
  } catch {
    return `${value.toFixed(decimalsFor(code))} ${code.toUpperCase()}`;
  }
};
