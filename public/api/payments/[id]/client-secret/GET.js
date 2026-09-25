import { getClientSecret } from '../../../../../server/utils/payments/actions.js';
import { gate } from '../../../../../server/utils/permissions/gate.js';

/*
  The client secret for a payment already in flight, so a payment form can be mounted against it
  again — a reloaded checkout, or a customer coming back to finish.

  Gated on `payments:create`, the same permission that starting a payment needs. A client secret is
  not a credential for the site, but it does let whoever holds it pay, cancel or read that one
  payment, so it is not something to hand out on the strength of knowing an id.

  A customer-facing "resume checkout" belongs in the consumer extension: it knows which order
  belongs to which session and can answer that question from its own records. This route cannot.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payments:create');
  if(gateError) return response.status(gateError.code).json({ error: gateError.msg });

  const [error, result] = await getClientSecret(request.params?.id);
  if(error) return response.status(error.code).json({ error: error.msg });

  response.json(result);
};
