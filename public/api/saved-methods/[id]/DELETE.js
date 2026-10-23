import { requireSession } from '../../../../server/utils/permissions/gate.js';
import { removeSavedCard } from '../../../../server/utils/customers/saved.js';

/*
  Forgets one of the signed-in customer's saved cards. Only their own: the card is checked against the
  customer behind the session's account, and one that is not theirs is a 404 as if it did not exist.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return response.status(sessionError.code).json({ error: sessionError.msg });

  const [error] = await removeSavedCard({ userId: session.user.id, methodId: request.params?.id });
  if(error) return response.status(error.code).json({ error: error.msg });

  response.json({ removed: true });
};
