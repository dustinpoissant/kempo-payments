import { cancelPayment } from '../../../../../server/utils/payments/actions.js';
import { gate } from '../../../../../server/utils/permissions/gate.js';

/*
  Releases a payment nothing has been taken from.

  Gated on `payments:capture` rather than a permission of its own: capturing and cancelling are the
  two halves of one decision — resolve an authorisation — and whoever is trusted to complete a sale
  is the same person trusted to call it off.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payments:capture');
  if(gateError) return response.status(gateError.code).json({ error: gateError.msg });

  const [error, result] = await cancelPayment(request.params?.id);
  if(error) return response.status(error.code).json({ error: error.msg });

  response.json(result);
};
