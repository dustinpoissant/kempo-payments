import { receiveWebhook } from '../../../../server/utils/webhooks/receive.js';
import { signatureHeaderFor } from '../../../../server/providers/index.js';

/*
  Where the processor reports what happened. The one route in this extension with no session behind
  it — the caller is Stripe, and it authenticates by signing the request rather than by logging in.

  Two details that are the whole reason this file is not three lines:

  **The raw body.** The signature covers the exact bytes that were sent, so verification has to run
  against them. `request.body` has already been through JSON.parse by the time this handler is
  called, and re-serialising it produces the same data with different whitespace and key order —
  which fails the check every time, for a payload that was never tampered with. `request.text()`
  returns what actually arrived.

  **What counts as a failure.** Only a request this endpoint could not honestly answer — a bad
  signature, a database that would not write. Anything else, including events about payments this
  site has never heard of, is a 200: a non-2xx tells the processor to redeliver, and redelivering
  an event nothing will ever act on just means the same failure again tomorrow, in a dashboard that
  eventually disables the endpoint for being broken.
*/
export default async (request, response) => {
  const provider = request.params?.provider;
  const header = signatureHeaderFor(provider);

  if(!header) return response.status(404).json({ error: 'No such payment provider' });

  const [error, result] = await receiveWebhook({
    provider,
    payload: await request.text(),
    signature: request.headers[header] || null,
  });

  if(error) return response.status(error.code).json({ error: error.msg });

  response.json({ received: true, ...result });
};
