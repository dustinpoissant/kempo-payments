import { capturePayment } from '../../../../../server/utils/payments/actions.js';
import { gate } from '../../../../../server/utils/permissions/gate.js';

/*
  Takes the money that was authorised.

  An amount may be given to capture less than was held — an order that shipped short. Leaving it
  off captures the whole authorisation, which is what the button on the admin screen does.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payments:capture');
  if(gateError) return response.status(gateError.code).json({ error: gateError.msg });

  const amount = request.body?.amount;

  const [error, result] = await capturePayment(request.params?.id, {
    amount: amount === undefined || amount === null || amount === '' ? undefined : Number(amount),
  });
  if(error) return response.status(error.code).json({ error: error.msg });

  response.json(result);
};
