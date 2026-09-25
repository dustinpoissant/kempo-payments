import crypto from 'crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoPayment, kempoPaymentRefund } from '../../db/schema.js';
import { hasNulByte } from './text.js';

/*
  Every read and write of this extension's own rows, and nothing else. No provider calls, no
  permission checks, no hooks — those belong to the layers either side, and keeping them out is
  what lets the data-layer test suite exercise all of this against a real database without a Stripe
  account existing anywhere.
*/

export const newId = () => crypto.randomBytes(8).toString('hex');

export const getPayment = async id => {
  if(!id) return [{ code: 400, msg: 'A payment id is required' }, null];

  try {
    const [row] = await db.select().from(kempoPayment).where(eq(kempoPayment.id, id)).limit(1);
    if(!row) return [{ code: 404, msg: 'No such payment' }, null];
    return [null, row];
  } catch {
    return [{ code: 500, msg: 'Could not load the payment' }, null];
  }
};

/*
  The lookup a webhook needs: the processor knows its own id for a payment and nothing about ours.
*/
export const getPaymentByRef = async (provider, providerRef) => {
  if(!provider || !providerRef) return [{ code: 400, msg: 'A provider and reference are required' }, null];

  try {
    const [row] = await db.select().from(kempoPayment)
      .where(and(eq(kempoPayment.provider, provider), eq(kempoPayment.providerRef, providerRef)))
      .limit(1);
    if(!row) return [{ code: 404, msg: 'No such payment' }, null];
    return [null, row];
  } catch {
    return [{ code: 500, msg: 'Could not load the payment' }, null];
  }
};

/*
  The lookup a consumer extension needs: it knows its own order number, not a payment id. Newest
  first, because a retried checkout leaves earlier abandoned attempts against the same reference
  and the live one is the last.
*/
export const paymentsForReference = async (owner, reference) => {
  if(!owner || !reference) return [{ code: 400, msg: 'An owner and reference are required' }, null];

  try {
    const rows = await db.select().from(kempoPayment)
      .where(and(eq(kempoPayment.owner, owner), eq(kempoPayment.reference, reference)))
      .orderBy(desc(kempoPayment.createdAt));
    return [null, rows];
  } catch {
    return [{ code: 500, msg: 'Could not load payments for that reference' }, null];
  }
};

export const insertPayment = async values => {
  const now = new Date();
  const row = {
    id: values.id || newId(),
    provider: values.provider,
    providerRef: values.providerRef,
    livemode: !!values.livemode,
    status: values.status,
    captureMethod: values.captureMethod || 'automatic',
    amount: values.amount,
    amountCaptured: values.amountCaptured || 0,
    amountRefunded: values.amountRefunded || 0,
    currency: values.currency,
    owner: values.owner || null,
    reference: values.reference || null,
    description: values.description || null,
    metadata: values.metadata || null,
    userId: values.userId || null,
    customerEmail: values.customerEmail || null,
    lastError: values.lastError || null,
    disputed: false,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.insert(kempoPayment).values(row);
    return [null, row];
  } catch {
    return [{ code: 500, msg: 'Could not record the payment' }, null];
  }
};

export const updatePayment = async (id, changes) => {
  try {
    const [row] = await db.update(kempoPayment)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(kempoPayment.id, id))
      .returning();
    if(!row) return [{ code: 404, msg: 'No such payment' }, null];
    return [null, row];
  } catch {
    return [{ code: 500, msg: 'Could not update the payment' }, null];
  }
};

/*
  Filtered, paged, newest first. `status` accepts a list so the admin screen can offer "needs
  attention" as one filter rather than making somebody look at four.
*/
export const listPayments = async ({ status, provider, owner, reference, userId, limit = 50, offset = 0 } = {}) => {
  if(hasNulByte(status, provider, owner, reference, userId)){
    return [{ code: 400, msg: 'Filters cannot contain null characters' }, null];
  }

  const conditions = [];
  if(status) conditions.push(Array.isArray(status) ? inArray(kempoPayment.status, status) : eq(kempoPayment.status, status));
  if(provider) conditions.push(eq(kempoPayment.provider, provider));
  if(owner) conditions.push(eq(kempoPayment.owner, owner));
  if(reference) conditions.push(eq(kempoPayment.reference, reference));
  if(userId) conditions.push(eq(kempoPayment.userId, userId));

  const where = conditions.length ? and(...conditions) : undefined;
  const take = Math.min(200, Math.max(1, Number(limit) || 50));
  const skip = Math.max(0, Number(offset) || 0);

  try {
    const rows = await db.select().from(kempoPayment)
      .where(where)
      .orderBy(desc(kempoPayment.createdAt))
      .limit(take)
      .offset(skip);

    const [counted] = await db.select({ total: sql`count(*)::int` }).from(kempoPayment).where(where);

    return [null, { payments: rows, total: counted?.total ?? rows.length, limit: take, offset: skip }];
  } catch {
    return [{ code: 500, msg: 'Could not list payments' }, null];
  }
};

/*
  What the admin screen puts across the top. One grouped query rather than one per status, and the
  gross/net pair kept separate on purpose — a day with £1,000 taken and £900 refunded is not the
  same day as one with £100 taken, and a single "total" would show them identically.
*/
export const summary = async () => {
  try {
    const rows = await db.select({
      status: kempoPayment.status,
      currency: kempoPayment.currency,
      count: sql`count(*)::int`,
      captured: sql`coalesce(sum(${kempoPayment.amountCaptured}), 0)::int`,
      refunded: sql`coalesce(sum(${kempoPayment.amountRefunded}), 0)::int`,
    })
      .from(kempoPayment)
      .groupBy(kempoPayment.status, kempoPayment.currency);

    const [disputes] = await db.select({ count: sql`count(*)::int` })
      .from(kempoPayment)
      .where(eq(kempoPayment.disputed, true));

    return [null, { byStatus: rows, disputed: disputes?.count ?? 0 }];
  } catch {
    return [{ code: 500, msg: 'Could not summarise payments' }, null];
  }
};

export const listRefunds = async paymentId => {
  try {
    const rows = await db.select().from(kempoPaymentRefund)
      .where(eq(kempoPaymentRefund.paymentId, paymentId))
      .orderBy(desc(kempoPaymentRefund.createdAt));
    return [null, rows];
  } catch {
    return [{ code: 500, msg: 'Could not load refunds' }, null];
  }
};

/*
  Records a refund, or updates the one already recorded for the same provider reference.

  Both paths reach here: the admin issuing one, and a webhook reporting one — including refunds
  nobody here issued at all, made from the processor's own dashboard. Keying on the provider's
  reference is what stops those two accounts of the same refund becoming two rows.
*/
export const recordRefund = async ({ paymentId, provider, providerRef, amount, currency, status, reason, issuedBy }) => {
  const now = new Date();

  try {
    const [existing] = await db.select().from(kempoPaymentRefund)
      .where(and(eq(kempoPaymentRefund.provider, provider), eq(kempoPaymentRefund.providerRef, providerRef)))
      .limit(1);

    if(existing){
      const [row] = await db.update(kempoPaymentRefund)
        .set({
          status,
          amount,
          // A refund made in the dashboard has no kempo user behind it; one already attributed
          // keeps whoever issued it rather than being blanked by the webhook that follows.
          issuedBy: existing.issuedBy || issuedBy || null,
          reason: existing.reason || reason || null,
          updatedAt: now,
        })
        .where(eq(kempoPaymentRefund.id, existing.id))
        .returning();
      return [null, row];
    }

    const row = {
      id: newId(),
      paymentId,
      provider,
      providerRef,
      amount,
      currency,
      status,
      reason: reason || null,
      issuedBy: issuedBy || null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(kempoPaymentRefund).values(row);
    return [null, row];
  } catch {
    return [{ code: 500, msg: 'Could not record the refund' }, null];
  }
};

/*
  The refunded total, recomputed from the refund rows rather than incremented.

  Incrementing is what produces a payment that says it has been refunded twice, because the admin
  action and the webhook that follows it are two reports of one refund. Summing rows that are
  themselves deduplicated by provider reference cannot double-count, however many times an event
  is redelivered.
*/
export const refundedTotal = async paymentId => {
  try {
    const [row] = await db.select({ total: sql`coalesce(sum(${kempoPaymentRefund.amount}), 0)::int` })
      .from(kempoPaymentRefund)
      .where(and(eq(kempoPaymentRefund.paymentId, paymentId), inArray(kempoPaymentRefund.status, ['succeeded', 'pending'])));
    return [null, row?.total ?? 0];
  } catch {
    return [{ code: 500, msg: 'Could not total the refunds' }, null];
  }
};
