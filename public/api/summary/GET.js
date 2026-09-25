import { summary } from '../../../server/utils/payments/store.js';
import { gate } from '../../../server/utils/permissions/gate.js';

/*
  The counts and totals across the top of the admin screen, grouped by status and currency.

  Grouped by currency because summing across them is meaningless — 100 JPY and 100 GBP added
  together is 200 of nothing.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payments:view');
  if(gateError) return response.status(gateError.code).json({ error: gateError.msg });

  const [error, result] = await summary();
  if(error) return response.status(error.code).json({ error: error.msg });

  response.json(result);
};
