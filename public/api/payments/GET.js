import { listPayments } from '../../../server/utils/payments/store.js';
import { gate } from '../../../server/utils/permissions/gate.js';

/*
  The payment list behind the admin screen. Paged, because a working store's payment table is the
  one that grows forever.

  `status` accepts a comma-separated list so "needs attention" can be one filter rather than four
  round trips.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payments:view');
  if(gateError) return response.status(gateError.code).json({ error: gateError.msg });

  const query = request.query || {};
  const status = query.status ? String(query.status).split(',').map(value => value.trim()).filter(Boolean) : undefined;

  const [error, result] = await listPayments({
    status: status?.length === 1 ? status[0] : status,
    provider: query.provider,
    owner: query.owner,
    reference: query.reference,
    userId: query.userId,
    limit: query.limit,
    offset: query.offset,
  });

  if(error) return response.status(error.code).json({ error: error.msg });

  response.json(result);
};
