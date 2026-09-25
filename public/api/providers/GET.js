import { listProviders } from '../../../server/providers/index.js';
import { gate } from '../../../server/utils/permissions/gate.js';

/*
  The processors this installation could be pointed at, and the credential fields each one needs.

  The settings screen builds its form from this rather than hard-coding Stripe's three keys, so a
  second provider module arrives with its own form and nothing in the admin has to be edited to
  show it.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payments:settings');
  if(gateError) return response.status(gateError.code).json({ error: gateError.msg });

  response.json({ providers: listProviders() });
};
