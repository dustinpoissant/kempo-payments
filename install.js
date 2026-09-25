import { sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';

/*
  Two things the declarative config cannot do.

  **The indexes.** kempo's installer generates `CREATE TABLE` from the Drizzle schema and reads
  columns and primary keys off it — indexes and unique constraints declared on a table are not
  carried across. For most extensions that is a performance footnote. Here one of them is a
  correctness guarantee: without a unique index on `(provider, providerRef)` two rows can claim the
  same charge, and every webhook after that updates whichever one the database happens to return
  first. So they are created here, by hand, matching what server/db/schema.js declares. A static
  test checks the two lists agree — a schema index that this file forgets exists only in
  development, where `drizzle-kit push` makes it.

  **The warning.** Every credential this extension stores is a `secret` setting, and kempo can only
  encrypt those when SETTINGS_ENCRYPTION_KEY is set. Without it the settings are silently not
  created, and the first sign of trouble is a settings screen that refuses to save a key with no
  explanation. Saying so at install time is the difference between a two-minute fix and an hour.
*/

const INDEXES = [
  sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoPayment_providerRef_idx" ON "kempoPayment" ("provider", "providerRef")`,
  sql`CREATE INDEX IF NOT EXISTS "kempoPayment_reference_idx" ON "kempoPayment" ("owner", "reference")`,
  sql`CREATE INDEX IF NOT EXISTS "kempoPaymentRefund_payment_idx" ON "kempoPaymentRefund" ("paymentId")`,
];

export default async () => {
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
