import { desc, eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoPaymentEvent } from '../../db/schema.js';
import { getProvider } from '../../providers/index.js';
import { getPaymentByRef } from '../payments/store.js';
import { applyDispute, applyProviderState, applyRefunds } from '../payments/sync.js';
import { stripNulBytes } from '../payments/text.js';

/*
  Where the processor tells us what happened.

  This is the authority on whether a payment succeeded — not the browser. A customer whose
  connection drops the instant after their card is charged never tells the site anything, and one
  who is determined to can make their browser claim whatever they like. The webhook comes from the
  processor, signed, and it arrives whether anybody's browser is still open or not.

  Three properties this endpoint has to have, in order of how expensive they are to get wrong:

  1. **Verified.** An unsigned request that reaches this endpoint could mark any payment paid. The
     signature check happens before the body is even looked at.
  2. **Idempotent.** Processors retry until they get a 2xx and may redeliver after one. Claiming a
     row in `kempoPaymentEvent` — whose primary key is the processor's own event id — is what makes
     the second delivery a no-op instead of a second order.
  3. **Forgiving about what it does not recognise.** An unknown event type is recorded and answered
     200. Returning an error would make the processor retry an event nothing here will ever act on.
*/

const claimEvent = async ({ provider, eventId, type, payload }) => {
  const id = `${provider}:${eventId}`;

  try {
    const [row] = await db.insert(kempoPaymentEvent).values({
      id,
      provider,
      providerEventId: eventId,
      type,
      payload,
      createdAt: new Date(),
    }).onConflictDoNothing().returning();

    // No row back means the primary key was already taken: we have seen this event before.
    return [null, row || null];
  } catch {
    return [{ code: 500, msg: 'Could not record the event' }, null];
  }
};

const finish = async (id, changes) => {
  try {
    await db.update(kempoPaymentEvent).set({ handledAt: new Date(), ...changes }).where(eq(kempoPaymentEvent.id, id));
  } catch {
    // The work itself already happened; failing to annotate the log entry is not worth failing the
    // webhook over, because a non-2xx would make the processor redeliver work that is already done.
  }
};

const release = async id => {
  try {
    await db.delete(kempoPaymentEvent).where(eq(kempoPaymentEvent.id, id));
  } catch {
    // Nothing more to do: the caller is already returning the failure that made this necessary.
  }
};

export const receiveWebhook = async ({ provider: providerName, payload, signature }) => {
  const [providerError, provider] = getProvider(providerName);
  if(providerError) return [providerError, null];

  const [verifyError, event] = await provider.verifyEvent({ payload, signature });
  if(verifyError) return [verifyError, null];

  return applyEvent(provider, event);
};

/*
  **No signature check happens here. Only kempo-payouts should call this.**

  Events about payments on connected accounts — Stripe Connect direct charges — are not sent to
  this extension's endpoint. Stripe delivers them to a separate *Connect* endpoint, signed with that
  endpoint's own secret, and kempo-payouts owns it. Once kempo-payouts has verified an event against
  that secret, it hands the event here so the payment row is updated by the same code, with the
  same idempotency and the same hooks, as every other payment — rather than payouts keeping a second
  copy of payment state.

  Whatever reaches this function is believed. Anything that passes a request body into it without
  verifying the signature first lets anybody on the internet mark any payment paid. It is in the SDK
  because an extension needs it, not because a route should.

  One check does remain: an event from a connected account is only applied to a payment made on
  that same account (see `applyEvent`), so a verified event cannot be pointed at somebody else's
  payment.
*/
export const receiveVerifiedEvent = async ({ provider: providerName = 'stripe', event } = {}) => {
  const [providerError, provider] = getProvider(providerName);
  if(providerError) return [providerError, null];
  if(!event?.id || !event?.type) return [{ code: 400, msg: 'An event needs an id and a type' }, null];

  return applyEvent(provider, event);
};

const applyEvent = async (provider, event) => {
  const [claimError, claimed] = await claimEvent({
    provider: provider.name,
    eventId: event.id,
    type: event.type,
    payload: stripNulBytes(event),
  });
  if(claimError) return [claimError, null];
  if(!claimed) return [null, { duplicate: true, type: event.type }];

  const interpreted = provider.interpretEvent(event);

  if(interpreted.kind === 'ignored'){
    await finish(claimed.id, {});
    return [null, { handled: false, type: event.type }];
  }

  /*
    An event about a payment this site has no record of. Normal, and not an error: one Stripe
    account can sit behind a staging site and a production one, and each will be sent the other's
    events. Recorded and acknowledged, so it stops being redelivered.
  */
  const [lookupError, payment] = await getPaymentByRef(provider.name, interpreted.providerRef);
  if(lookupError){
    await finish(claimed.id, { error: lookupError.code === 404 ? 'No matching payment' : lookupError.msg });
    return [null, { handled: false, type: event.type, unmatched: true }];
  }

  /*
    An event is only about a payment if both happened on the same account: a connected account's
    event for that account's payment, the platform's own event for the platform's. Anything else is
    recorded and left alone — an event arriving on the wrong endpoint, or from an account claiming a
    payment that is not its own.
  */
  if((interpreted.connectedAccount || null) !== (payment.connectedAccount || null)){
    await finish(claimed.id, { error: 'The event came from a different account than the payment was made on' });
    return [null, { handled: false, type: event.type, unmatched: true }];
  }

  let applyError = null;

  if(interpreted.kind === 'payment'){
    [applyError] = await applyProviderState(payment, interpreted.payment, {
      failed: event.type.endsWith('payment_failed'),
    });
  }

  if(interpreted.kind === 'refund'){
    let refunds = interpreted.refunds;

    /*
      An event that says a refund happened without saying which one — Stripe's `charge.refunded`
      reports only the new total — is answered by asking the processor, since there is nothing to
      record otherwise. Without this such a refund was "handled" as a no-op and never appeared.
    */
    if(!refunds.length && provider.listRefunds){
      [applyError, refunds] = await provider.listRefunds(payment.providerRef, { connectedAccount: payment.connectedAccount });
    }

    if(!applyError) [applyError] = await applyRefunds(payment, refunds);
  }

  if(interpreted.kind === 'dispute'){
    [applyError] = await applyDispute(payment, interpreted);
  }

  /*
    Handled means applied. The claim is what turns a redelivery into a no-op, so a claim left behind
    by an event that then failed to apply would make the processor's retry — the very thing the
    non-2xx below asks for — answer "duplicate" and drop it for good, leaving the payment wrong
    until somebody noticed. Found by testing: a refund that could not be recorded stayed
    unrecorded, and its retry was swallowed. Releasing the claim lets the retry do the work.
  */
  if(applyError){
    await release(claimed.id);
    return [applyError, null];
  }

  await finish(claimed.id, { paymentId: payment.id });

  return [null, { handled: true, type: event.type, paymentId: payment.id }];
};

export const listEvents = async (paymentId, limit = 25) => {
  try {
    const rows = await db.select().from(kempoPaymentEvent)
      .where(eq(kempoPaymentEvent.paymentId, paymentId))
      .orderBy(desc(kempoPaymentEvent.createdAt))
      .limit(Math.min(100, Math.max(1, Number(limit) || 25)));
    return [null, rows];
  } catch {
    return [{ code: 500, msg: 'Could not load the event log' }, null];
  }
};
