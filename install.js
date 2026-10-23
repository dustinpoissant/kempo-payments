import { sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';

/*
  Three things the declarative config cannot do.

  **The indexes.** kempo's installer generates `CREATE TABLE` from the Drizzle schema and reads
  columns and primary keys off it — indexes and unique constraints declared on a table are not
  carried across. For most extensions that is a performance footnote. Here one of them is a
  correctness guarantee: without a unique index on `(provider, providerRef)` two rows can claim the
  same charge, and every webhook after that updates whichever one the database happens to return
  first. So they are created here, by hand, matching what server/db/schema.js declares. A static
  test checks the two lists agree — a schema index that this file forgets exists only in
  development, where `drizzle-kit push` makes it.

  **The columns added since the tables were first created.** kempo creates a table that is missing
  and never alters one that exists, so a site that installed before `connectedAccount` and
  `applicationFee` would never get them, and every payment read would fail on a missing column.
  `IF NOT EXISTS` makes adding them safe on every install and update. A failure here fails the
  install: carrying on without them breaks every payment, not just the new kind.

  **The warning.** Every credential this extension stores is a `secret` setting, and kempo can only
  encrypt those when SETTINGS_ENCRYPTION_KEY is set. Without it the settings are silently not
  created, and the first sign of trouble is a settings screen that refuses to save a key with no
  explanation. Saying so at install time is the difference between a two-minute fix and an hour.
*/

export const COLUMNS = [
  { name: 'kempoPayment.connectedAccount', sql: sql`ALTER TABLE "kempoPayment" ADD COLUMN IF NOT EXISTS "connectedAccount" text` },
  { name: 'kempoPayment.applicationFee', sql: sql`ALTER TABLE "kempoPayment" ADD COLUMN IF NOT EXISTS "applicationFee" integer` },
];

/*
  Tables added after the first release. kempo creates the tables of a fresh install from the schema, but an
  update never alters or adds to a database that already exists, so a site that installed before saved
  cards gets `kempoPaymentCustomer` here. `IF NOT EXISTS` makes it safe on every install and update, and
  the statement must match server/db/schema.js (a test checks it).
*/
export const TABLES = [
  {
    name: 'kempoPaymentCustomer',
    sql: sql`CREATE TABLE IF NOT EXISTS "kempoPaymentCustomer" ("id" text PRIMARY KEY NOT NULL, "userId" text NOT NULL, "provider" text NOT NULL, "livemode" boolean DEFAULT false NOT NULL, "providerRef" text NOT NULL, "createdAt" timestamp NOT NULL)`,
  },
];

const INDEXES = [
  sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoPayment_providerRef_idx" ON "kempoPayment" ("provider", "providerRef")`,
  sql`CREATE INDEX IF NOT EXISTS "kempoPayment_reference_idx" ON "kempoPayment" ("owner", "reference")`,
  sql`CREATE INDEX IF NOT EXISTS "kempoPaymentRefund_payment_idx" ON "kempoPaymentRefund" ("paymentId")`,
];

export const ensureTables = async () => {
  for(const table of TABLES){
    try {
      await db.execute(table.sql);
    } catch(error) {
      throw new Error(`[kempo-payments] Could not create the table ${table.name}: ${error.message}`);
    }
  }
};

export const ensureColumns = async () => {
  for(const column of COLUMNS){
    try {
      await db.execute(column.sql);
    } catch(error) {
      throw new Error(`[kempo-payments] Could not add the column ${column.name}: ${error.message}`);
    }
  }
};

export default async () => {
  await ensureTables();
  await ensureColumns();

  for(const statement of INDEXES){
    try {
      await db.execute(statement);
    } catch(error) {
      console.warn(`[kempo-payments] Could not create an index: ${error.message}`);
    }
  }

  if(!process.env.SETTINGS_ENCRYPTION_KEY){
    console.warn([
      '[kempo-payments] SETTINGS_ENCRYPTION_KEY is not set, so the API credentials cannot be stored.',
      '  Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      '  Put it in .env, restart, then reinstall this extension.',
      '  Back it up somewhere — losing it makes every stored secret on the site unrecoverable.',
    ].join('\n'));
    return;
  }

  console.log('[kempo-payments] Installed. Connect a processor at /admin/extension/kempo-payments/ — nothing can be charged until you do.');
};
