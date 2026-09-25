import { sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoPayment, kempoPaymentEvent, kempoPaymentRefund } from '../server/db/schema.js';
import { insertPayment, listPayments, newId } from '../server/utils/payments/store.js';
import { databaseReachable, skipReason } from './testDatabase.js';
import install from '../install.js';
import update from '../update.js';
import uninstall from '../uninstall.js';

/*
  What kempo runs when this extension is installed, updated and removed.

  The install script is the interesting one. kempo's own installer builds tables from the Drizzle
  schema and carries across columns and primary keys only, so the indexes this extension needs —
  above all the unique one that stops two rows claiming the same charge — exist because this script
  makes them. In development `drizzle-kit push` makes them too, which is exactly why a bug here
  would never show: the test database already has them. So these tests drop them first.

  Requires the same database as data-layer.node-test.js and skips itself without one.
*/


const skipped = reason => ({
  'lifecycle (SKIPPED)': async ({ pass }) => pass(`skipped: ${reason}`),
});

const INDEXES = ['kempoPayment_providerRef_idx', 'kempoPayment_reference_idx', 'kempoPaymentRefund_payment_idx'];

const purge = async () => {
  await db.delete(kempoPaymentEvent).catch(() => {});
  await db.delete(kempoPaymentRefund).catch(() => {});
  await db.delete(kempoPayment).catch(() => {});
};

const existingIndexes = async () => {
  const rows = await db.execute(sql`select indexname, indexdef from pg_indexes where tablename in ('kempoPayment', 'kempoPaymentRefund')`);
  return new Map(rows.map(row => [row.indexname, row.indexdef]));
};

const dropIndexes = async () => {
  for(const name of INDEXES) await db.execute(sql.raw(`DROP INDEX IF EXISTS "${name}"`));
};

// Captures console output for one run, and always puts the real console back.
const captured = async run => {
  const real = { log: console.log, warn: console.warn };
  const lines = { log: [], warn: [] };
  console.log = message => lines.log.push(String(message));
  console.warn = message => lines.warn.push(String(message));
  try {
    await run();
  } finally {
    console.log = real.log;
    console.warn = real.warn;
  }
  return lines;
};

const withKey = async (key, run) => {
  const before = process.env.SETTINGS_ENCRYPTION_KEY;
  if(key === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
  else process.env.SETTINGS_ENCRYPTION_KEY = key;
  try {
    return await run();
  } finally {
    if(before === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = before;
  }
};

const seed = overrides => insertPayment({
  provider: 'stripe',
  providerRef: `pi_${newId()}`,
  status: 'succeeded',
  amount: 5000,
  amountCaptured: 5000,
  currency: 'usd',
  ...overrides,
});

export default !databaseReachable ? skipped(`${skipReason} — point DATABASE_URL at a *_test database and run drizzle-kit push`) : {
  'install creates every index the extension depends on, including the unique one': async ({ pass, fail }) => {
    await dropIndexes();
    const before = await existingIndexes();
    if(INDEXES.some(name => before.has(name))) return fail('setup: the indexes were not dropped, so this cannot show that install creates them');

    await captured(() => install());
    const after = await existingIndexes();

    for(const name of INDEXES){
      if(!after.has(name)) return fail(`"${name}" does not exist after install — a fresh site would run without it`);
    }
    if(!/UNIQUE/i.test(after.get('kempoPayment_providerRef_idx'))){
      return fail('the (provider, providerRef) index exists but is not unique, so two rows could claim one charge');
    }
    pass('all three, and the one that matters is UNIQUE');
  },

  /*
    The reason the unique index exists at all. Without it a second row for the same charge is
    accepted, and every webhook after that updates whichever of the two the database returns first.
  */
  'a second row for the same charge is refused once install has run': async ({ pass, fail }) => {
    await purge();
    const ref = `pi_${newId()}`;

    const [firstError] = await seed({ providerRef: ref });
    if(firstError) return fail(`the first row was refused: ${firstError.msg}`);

    const [secondError, second] = await seed({ providerRef: ref });
    if(!secondError || second) return fail('a duplicate (provider, providerRef) was accepted');

    const [, page] = await listPayments({ limit: 10 });
    if(page.total !== 1) return fail(`${page.total} rows exist for one charge`);

    await purge();
    pass('the duplicate came back as an error tuple, and only one row exists');
  },

  'install and update can be run repeatedly, from any state, without complaint': async ({ pass, fail }) => {
    const output = await captured(async () => {
      await install();
      await install();
      await update();
      await update();
    });

    const indexProblems = output.warn.filter(line => line.includes('Could not create an index'));
    if(indexProblems.length) return fail(`re-running complained: ${indexProblems[0]}`);

    const after = await existingIndexes();
    for(const name of INDEXES){
      if(!after.has(name)) return fail(`"${name}" went missing after a repeat run`);
    }
    pass('idempotent — IF NOT EXISTS all the way down');
  },

  'install says so, at install time, when the encryption key is missing': async ({ pass, fail }) => {
    const missing = await withKey(undefined, () => captured(() => install()));
    if(!missing.warn.some(line => line.includes('SETTINGS_ENCRYPTION_KEY is not set'))){
      return fail('no warning about the missing key — the first sign of trouble would be a settings screen that silently refuses to save');
    }
    if(missing.log.some(line => line.includes('Installed.'))) return fail('claimed to be installed despite having nowhere to store a credential');
    if(!missing.warn.some(line => line.includes('randomBytes'))) return fail('the warning does not say how to generate a key');

    const present = await withKey('a'.repeat(64), () => captured(() => install()));
    if(present.warn.some(line => line.includes('SETTINGS_ENCRYPTION_KEY'))) return fail('warned about a key that is set');
    if(!present.log.some(line => line.includes('Installed.'))) return fail('did not say it was installed');
    pass('warns with the fix when missing, stays quiet when set');
  },

  'uninstall reports how much will be lost and names every uncaptured hold': async ({ pass, fail }) => {
    await purge();
    const held = `pi_hold_${newId()}`;
    const alsoHeld = `pi_hold_${newId()}`;
    await seed({ providerRef: held, status: 'requires_capture', amount: 2500, amountCaptured: 0 });
    await seed({ providerRef: alsoHeld, status: 'requires_capture', amount: 900, amountCaptured: 0, currency: 'gbp' });
    await seed({});

    const output = await captured(() => uninstall());

    if(!output.log.some(line => line.includes('3 payment records will be dropped'))) return fail(`the count was not reported: ${output.log.join(' | ')}`);
    if(!output.warn.some(line => line.includes('2 payments are authorised but not captured'))) return fail(`the holds were not counted: ${output.warn.join(' | ')}`);
    if(!output.warn.some(line => line.includes(held) && line.includes('2500 USD'))) return fail('the first hold was not named with its amount');
    if(!output.warn.some(line => line.includes(alsoHeld) && line.includes('900 GBP'))) return fail('the second hold was not named with its amount and currency');

    const [, page] = await listPayments({ limit: 10 });
    if(page.total !== 3) return fail(`uninstall deleted rows itself (${page.total} left) — dropping is kempo's job, and this only warns`);

    await purge();
    pass('says what will go, names each hold with its amount, and deletes nothing itself');
  },

  'uninstall stays quiet about holds when there are none': async ({ pass, fail }) => {
    await purge();
    await seed({});

    const output = await captured(() => uninstall());
    if(output.warn.length) return fail(`warned with nothing to warn about: ${output.warn[0]}`);
    if(!output.log.some(line => line.includes('1 payment record will be dropped'))) return fail('the singular was not handled');

    await purge();
    pass('no false alarm, and the grammar copes with one');
  },
};
