import { requireSession } from '../../../server/utils/permissions/gate.js';
import { listSavedCards } from '../../../server/utils/customers/saved.js';

/*
  The signed-in customer's own saved cards, for the payment form: brand, last four digits and expiry,
  nothing that can be charged. Needs a session and no permission, since it is only ever the caller's own
  account (the user comes from the session, never the request). A guest gets a 401, which is how the form
  knows to offer "create an account to save your card" instead.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return response.status(sessionError.code).json({ error: sessionError.msg });

  const [error, result] = await listSavedCards({ userId: session.user.id });
  if(error) return response.status(error.code).json({ error: error.msg });

  response.json(result);
};
