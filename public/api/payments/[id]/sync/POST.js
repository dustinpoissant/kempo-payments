import { syncPayment } from '../../../../../server/utils/payments/sync.js';
import { gate } from '../../../../../server/utils/permissions/gate.js';

/*
  Asks the processor what it thinks and writes the answer down.

  A repair tool, not part of the normal path — webhooks are. It exists because the normal path has
  one failure mode that is invisible from here: an endpoint that was never registered, or was
  registered with the wrong signing secret, means payments succeed at the processor and stay
  `processing` on this site forever. This is the button that fixes a payment in that state, and the
  proof of what went wrong when it fixes every one of them.

  A POST rather than a GET because it writes and it can fire hooks.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payments:view');
  if(gateError) return response.status(gateError.code).json({ error: gateError.msg });

  const [error, result] = await syncPayment(request.params?.id);
  if(error) return response.status(error.code).json({ error: error.msg });

  response.json(result);
};
