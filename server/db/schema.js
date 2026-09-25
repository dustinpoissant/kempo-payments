import { pgTable, text, boolean, integer, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

/*
  Three tables, and none of them holds a card number.

  Nothing sensitive ever reaches this server: the customer's details go straight from their browser
  to the processor, and what comes back is a reference. Everything below is kempo's own record of
  what that reference was for — who it belonged to, what it was meant to pay for, and what has
  happened to it since. Rebuilding any of it means asking the processor, which is exactly the
  position to be in when the processor is the one holding the money.

  Amounts are integers in the currency's minor unit — cents, pence, yen. Never floats. `1.15` is
  not representable in binary floating point, and a rounding error in a total is money that either
  the customer or the seller is short.
*/

/*
  One row per attempt to take money, created the moment a charge is started and updated for the
  rest of its life. It is the row a consumer extension (checkout, a subscription, a top-up) points
  its own order at via `reference`.

  `providerRef` is the processor's own id for the same thing — Stripe's PaymentIntent. That is the
  join back to the money, and it is what a webhook arrives carrying, so it is indexed.

  `status` is a normalised vocabulary shared by every provider, not Stripe's. A second processor
  maps its own states onto these rather than the rest of kempo learning a new set of words. See
  server/utils/payments/statuses.js for what each one means and which of them are final.
*/
export const kempoPayment = pgTable('kempoPayment', {
  id: text('id').primaryKey(),

  provider: text('provider').notNull(),
  providerRef: text('providerRef').notNull(),
  livemode: boolean('livemode').notNull().default(false),

  status: text('status').notNull(),
  captureMethod: text('captureMethod').notNull().default('automatic'),

  amount: integer('amount').notNull(),
  amountCaptured: integer('amountCaptured').notNull().default(0),
  amountRefunded: integer('amountRefunded').notNull().default(0),
  currency: text('currency').notNull(),

  /*
    Who asked for the payment and what it was for, in their terms. `owner` is the extension that
    called `createPayment` and `reference` is its own id for the thing being paid for — an order
    number, a subscription id. Together they are how a consumer finds its payment again without
    keeping a second table of its own mapping ids to ids.
  */
  owner: text('owner'),
  reference: text('reference'),
  description: text('description'),
  metadata: jsonb('metadata'),

  /*
    Nullable on purpose. A guest checkout is a real payment by a person with no account, and
    refusing to record it would mean either inventing an account or not taking the money.
  */
  userId: text('userId'),
  customerEmail: text('customerEmail'),

  /*
    The last thing the processor said went wrong, kept so a declined card can be explained to
    somebody looking at the payment later. Cleared on the next successful transition rather than
    accumulating — a payment that eventually succeeded is not a failed one.
  */
  lastError: text('lastError'),

  disputed: boolean('disputed').notNull().default(false),

  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
}, table => ({
  providerRefIndex: uniqueIndex('kempoPayment_providerRef_idx').on(table.provider, table.providerRef),
  referenceIndex: index('kempoPayment_reference_idx').on(table.owner, table.reference),
}));

/*
  One row per refund, because a payment can have several and "amountRefunded" alone cannot say who
  issued them, when, or why.

  Kept even when the refund fails: a refund that was attempted and rejected is something the person
  who attempted it needs to see, and a missing row reads as though nobody ever tried.
*/
export const kempoPaymentRefund = pgTable('kempoPaymentRefund', {
  id: text('id').primaryKey(),
  paymentId: text('paymentId').notNull(),

  provider: text('provider').notNull(),
  providerRef: text('providerRef').notNull(),

  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull(),
  reason: text('reason'),

  // The kempo user who pressed the button, where there was one. Null for a refund the processor
  // originated itself — a dispute lost, a card network reversal.
  issuedBy: text('issuedBy'),

  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
}, table => ({
  paymentIndex: index('kempoPaymentRefund_payment_idx').on(table.paymentId),
}));

/*
  Every webhook this extension has already acted on.

  Processors retry a webhook until they get a 2xx, and they are explicitly allowed to deliver the
  same event more than once even after one. Without this table a retried `payment_intent.succeeded`
  fires `payment:succeeded` a second time, and whatever is listening — an order confirmation email,
  a licence key, a shipment — happens twice. Claiming a row here is what makes the handler
  idempotent, and it is the whole reason the table exists.

  The primary key is `provider:eventId` rather than a generated one, deliberately. kempo's
  installer creates columns and primary keys and nothing else — a `unique()` or a unique index in a
  Drizzle schema is not carried across (see install.js, which adds this extension's indexes by
  hand). Hanging deduplication off the one constraint the installer is guaranteed to create means
  it cannot quietly stop working on a site whose indexes did not get made.

  `payload` is kept because a webhook is the only account of what the processor believed at that
  moment, and it is the first thing anybody asks for when a payment and an order disagree.
*/
export const kempoPaymentEvent = pgTable('kempoPaymentEvent', {
  id: text('id').primaryKey(),

  provider: text('provider').notNull(),
  providerEventId: text('providerEventId').notNull(),
  type: text('type').notNull(),

  paymentId: text('paymentId'),
  payload: jsonb('payload'),

  // Null until it has been processed; set even for an event that was recognised and deliberately
  // ignored, so "seen but not actionable" is distinguishable from "still queued".
  handledAt: timestamp('handledAt'),
  error: text('error'),

  createdAt: timestamp('createdAt').notNull(),
});
