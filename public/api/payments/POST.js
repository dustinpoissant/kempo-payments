import { createPayment } from '../../../server/utils/payments/create.js';
import { gate } from '../../../server/utils/permissions/gate.js';

/*
  Starts a payment over HTTP.

  Gated behind `payments:create`, which no ordinary visitor holds — and that is not an oversight.
  The amount is in the request body, so an open version of this route would let anyone decide what
  they owe. A customer-facing checkout works the other way round: the consumer extension computes
  the amount on its own server, calls `createPayment` from the SDK, and sends only the resulting
  client secret to the browser.

  What this route is for is the other callers — the admin's own test payment, a script, an
  integration that already authenticates as somebody trusted.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'payments:create');
  if(gateError) return response.status(gateError.code).json({ error: gateError.msg });

  const body = request.body || {};

  const [error, result] = await createPayment({
    amount: typeof body.amount === 'string' ? Number(body.amount) : body.amount,
    currency: body.currency,
    description: body.description || null,
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : null,
    captureMethod: body.captureMethod || null,
    owner: body.owner || null,
    reference: body.reference || null,
    /*
      Whoever is signed in, unless they named somebody else. A payment created on behalf of a
      customer by a member of staff belongs to the customer, not to the person who typed it in.
    */
    userId: body.userId || session.user.id,
    customerEmail: body.customerEmail || null,
  });

  if(error) return response.status(error.code).json({ error: error.msg });

  response.json(result);
};
