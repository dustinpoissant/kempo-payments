/*
  Formatting money in the browser, served at /payments/utils/money.js.

  The same minor-unit rules as server/utils/money/currencies.js, kept as a separate small copy on
  purpose: the server module imports kempo's server SDK, and a browser cannot load that. A static
  test checks the two lists of zero- and three-decimal currencies still agree, because the day they
  drift is the day a screen shows ¥1,200 as ¥12.00.
*/

export const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

export const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

export const decimalsFor = currency => {
  const code = String(currency || '').toLowerCase();
  if(ZERO_DECIMAL.has(code)) return 0;
  if(THREE_DECIMAL.has(code)) return 3;
  return 2;
};

export const fromMinor = (minor, currency) => Number(minor || 0) / 10 ** decimalsFor(currency);

export const toMinor = (major, currency) => {
  const amount = Number(major);
  if(!Number.isFinite(amount)) return null;
  return Math.round(amount * 10 ** decimalsFor(currency));
};

export const formatAmount = (minor, currency) => {
  const code = String(currency || 'usd').toLowerCase();
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code.toUpperCase() }).format(fromMinor(minor, code));
  } catch {
    return `${fromMinor(minor, code).toFixed(decimalsFor(code))} ${code.toUpperCase()}`;
  }
};

/*
  Statuses read as machine names — `requires_payment_method` — and a customer or a shop owner
  should never see one. These are what a screen shows instead.
*/
export const STATUS_LABELS = {
  requires_payment_method: 'Awaiting payment',
  requires_confirmation: 'Awaiting confirmation',
  requires_action: 'Awaiting the customer’s bank',
  processing: 'Processing',
  requires_capture: 'Authorised, not captured',
  succeeded: 'Paid',
  canceled: 'Cancelled',
  failed: 'Failed',
};

export const statusLabel = status => STATUS_LABELS[status] || status;

/*
  Which colour a status badge gets. Only `succeeded` is good news, only `failed` is bad; everything
  else is in progress and should not be coloured as though somebody needs to do something about it.
*/
export const statusTone = status => {
  if(status === 'succeeded') return 'success';
  if(status === 'failed' || status === 'canceled') return 'danger';
  if(status === 'requires_capture') return 'warning';
  return 'muted';
};
