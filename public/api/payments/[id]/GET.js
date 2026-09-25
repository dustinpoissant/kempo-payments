import { getPayment, listRefunds } from '../../../../server/utils/payments/store.js';
import { listEvents } from '../../../../server/utils/webhooks/receive.js';
import { refundableAmount } from '../../../../server/utils/payments/statuses.js';
import { gate } from '../../../../server/utils/permissions/gate.js';

/*
  One payment, with everything anybody looking at it needs in one response: the refunds against it
  and the processor events that produced its current state.

  The event log is included rather than being a separate screen because it is the answer to the
  only hard question a payment screen ever gets — "the customer says they paid, why does this say
  they did not" — and the answer is usually a webhook that never arrived.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payments:view');
  if(gateError) return response.status(gateError.code).json({ error: gateError.msg });

  const [error, payment] = await getPayment(request.params?.id);
  if(error) return response.status(error.code).json({ error: error.msg });

  const [, refunds] = await listRefunds(payment.id);
  const [, events] = await listEvents(payment.id);

  response.json({
    payment,
    refunds: refunds || [],
    events: events || [],
    refundable: refundableAmount(payment),
  });
};
