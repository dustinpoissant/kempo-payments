import { getSession, currentUserHasPermission } from 'kempo/server/sdk.js';

/*
  The same shape kempo-thumbs and kempo-user-dirs use, for the same reason: a permission check
  written out longhand in every route is one that eventually has a clause wrong somewhere.

  Every route in this extension is gated except two, and both are deliberate: the webhook endpoint
  (authenticated by the provider's signature instead, since the caller is Stripe and has no
  session) and the client config endpoint (it returns a publishable key, which is designed to be
  seen by every visitor, and a checkout page has to work for a guest with no account).
*/

export const requireSession = async request => {
  const token = request.cookies?.session_token;
  if(!token) return [{ code: 401, msg: 'Authentication required' }, null];

  const [error, session] = await getSession({ token });
  if(error || !session?.user) return [{ code: 401, msg: 'Authentication required' }, null];

  return [null, { token, user: session.user }];
};

export const requirePermission = async (token, name) => {
  const [error, allowed] = await currentUserHasPermission(token, name);
  if(error) return [{ code: error.code, msg: error.msg }, null];
  if(!allowed) return [{ code: 403, msg: 'Insufficient permissions' }, null];
  return [null, true];
};

/*
  The two together, since every gated route in this extension needs both and none of them needs
  them apart.
*/
export const gate = async (request, permission) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return [sessionError, null];

  const [permError] = await requirePermission(session.token, permission);
  if(permError) return [permError, null];

  return [null, session];
};
