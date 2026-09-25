/*
  Browser client, served at /payments/sdk.js.

  Mirrors the server SDK's names so a call reads the same on either side, and returns the same
  [error, data] tuples the rest of kempo uses.

  Note what is *not* here: nothing that confirms a payment. Confirming is the payment form's job
  and it talks to the processor directly, so no card detail ever passes through this site. See
  components/PaymentForm.js.
*/

const BASE = '/payments/api';

const request = async (path, options = {}) => {
  try {
    const response = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if(!response.ok) return [{ code: response.status, msg: data.error || response.statusText }, null];
    return [null, data];
  } catch(error) {
    return [{ code: 0, msg: error.message }, null];
  }
};

const json = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

const query = params => {
  const search = new URLSearchParams();
  for(const [key, value] of Object.entries(params || {})){
    if(value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const string = search.toString();
  return string ? `?${string}` : '';
};

/*
  Which processor is configured and its publishable key. The one call here that works for a visitor
  with no account, because a checkout page has to.
*/
export const getConfig = () => request('/config');

export const listPayments = (params = {}) => request(`/payments${query(params)}`);

export const getPayment = id => request(`/payments/${id}`);

export const createPayment = body => request('/payments', json('POST', body));

export const getClientSecret = id => request(`/payments/${id}/client-secret`);

export const capturePayment = (id, { amount } = {}) => request(`/payments/${id}/capture`, json('POST', { amount }));

export const cancelPayment = id => request(`/payments/${id}/cancel`, json('POST'));

export const refundPayment = (id, { amount, reason } = {}) => request(`/payments/${id}/refund`, json('POST', { amount, reason }));

/*
  Re-reads the payment from the processor. For the case where a webhook has not arrived — see the
  route's own note.
*/
export const syncPayment = id => request(`/payments/${id}/sync`, json('POST'));

export const getSummary = () => request('/summary');

export const listProviders = () => request('/providers');

export const getSettings = () => request('/settings');

export const saveSettings = body => request('/settings', json('PUT', body));
