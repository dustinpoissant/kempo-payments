import { listDisputes } from '../../../server/utils/disputes/list.js';
import { gate } from '../../../server/utils/permissions/gate.js';

/*
  The processor's disputes, read live. `status` is `open`, `closed` or `all` (the default).
  Whoever may see payments may see these.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payments:view');
  if(gateError) return response.status(gateError.code).json({ error: gateError.msg });

  const requested = String(request.query?.status ?? 'all');
  const filter = ['open', 'closed', 'all'].includes(requested) ? requested : 'all';

  const [error, result] = await listDisputes({ filter });
  if(error) return response.status(error.code).json({ error: error.msg });

  response.json(result);
};
