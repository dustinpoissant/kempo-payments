import { refundPayment } from '../../../../../server/utils/payments/actions.js';
import { gate } from '../../../../../server/utils/permissions/gate.js';

/*
  Gives money back.

  Omitting the amount refunds everything still outstanding. The reason is recorded and shown next
  to the refund afterwards — a free-text one is kept even where the processor only accepts a short
  list of its own, because it was written for a person to read, not for the processor.

  `issuedBy` is the signed-in user rather than anything in the body. Who refunded what is exactly
  the field nobody should be able to set on their own behalf.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'payments:refund');
  if(gateError) return response.status(gateError.code).json({ error: gateError.msg });

  const amount = request.body?.amount;

  const [error, result] = await refundPayment(request.params?.id, {
    amount: amount === undefined || amount === null || amount === '' ? undefined : Number(amount),
    reason: request.body?.reason || null,
    issuedBy: session.user.id,
  });
  if(error) return response.status(error.code).json({ error: error.msg });

  response.json(result);
};
