import { getTableConfig } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { deleteSetting, setSetting } from 'kempo/server/sdk.js';
import { kempoPaymentCustomer } from '../server/db/schema.js';
import { ensureTables, TABLES } from '../install.js';
import { ensureCustomer, listSavedCards, removeSavedCard } from '../server/utils/customers/saved.js';
import { readConfig, DEFAULTS } from '../server/utils/config/settings.js';
import getSavedMethods from '../public/api/saved-methods/GET.js';
import deleteSavedMethod from '../public/api/saved-methods/[id]/DELETE.js';
import { SAVEABLE } from '../public/api/settings/PUT.js';
import { databaseReachable, skipReason } from './testDatabase.js';

/*
  Saved cards. Nothing here talks to Stripe: what can be proved without it is proved (the table exists and
  matches the schema, the setting turns everything off, a guest or an unconfigured site gets nothing, a bad
  card id is refused, and the routes need a session). The calls that need the processor (making a customer,
  listing, saving and removing a card) are exercised against Stripe's test mode by the manual procedure in
  the README.
*/

const fakeResponse = () => {
  const out = { status: 200, body: null };
  const response = { status: code => { out.status = code; return response; }, json: body => { out.body = body; return response; } };
  return [response, out];
};

const disconnect = async () => {
  for(const name of ['stripe_secret_key', 'stripe_webhook_secret', 'stripe_publishable_key', 'save_cards']) await deleteSetting('kempo-payments', name).catch(() => {});
};

const suite = {
  'the customer table is created from install.js and matches the schema': async ({ pass, fail }) => {
    await db.execute(sql`DROP TABLE IF EXISTS "kempoPaymentCustomer"`);
    await ensureTables();
    await ensureTables();
    const { columns } = getTableConfig(kempoPaymentCustomer);
    const found = await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'kempoPaymentCustomer'`);
    const have = new Set(found.map(row => row.column_name));
    const missing = columns.map(column => column.name).filter(name => !have.has(name));
    if(missing.length) return fail(`the table is missing ${missing.join(', ')}`);
    if(!TABLES.some(table => table.name === 'kempoPaymentCustomer')) return fail('install.js does not list the table');
    pass(`${columns.length} columns, created twice without error`);
  },

  'saved cards are on unless the setting is turned off, and the setting can be saved': async ({ pass, fail }) => {
    await disconnect();
    if((await readConfig()).saveCards !== DEFAULTS.saveCards || DEFAULTS.saveCards !== true) return fail('saved cards should be on by default');
    await setSetting('kempo-payments', 'save_cards', false, 'boolean', false, 'x');
    if((await readConfig()).saveCards !== false) return fail('a false setting should turn it off');
    await setSetting('kempo-payments', 'save_cards', true, 'boolean', false, 'x');
    if((await readConfig()).saveCards !== true) return fail('a true setting should turn it on');
    if(!SAVEABLE.includes('save_cards')) return fail('the settings route does not allow save_cards');
    await disconnect();
    pass('on by default, off when false, saveable from the admin screen');
  },

  'with saving off, or no processor connected, nothing is made or listed': async ({ pass, fail }) => {
    await disconnect();
    const [noProcessorError, nothingMade] = await ensureCustomer({ userId: 'user-1', email: 'a@example.com' });
    if(noProcessorError || nothingMade !== null) return fail('an unconfigured site should quietly have no customer');
    const [, listed] = await listSavedCards({ userId: 'user-1' });
    if(listed.enabled !== false || listed.methods.length) return fail('an unconfigured site should list no cards');

    await setSetting('kempo-payments', 'save_cards', false, 'boolean', false, 'x');
    const [offError, offMade] = await ensureCustomer({ userId: 'user-1' });
    if(offError || offMade !== null) return fail('saving off should make no customer');
    const [, offListed] = await listSavedCards({ userId: 'user-1' });
    if(offListed.enabled !== false) return fail('saving off should say so');
    await disconnect();
    pass('no customer is made and the list says saving is off');
  },

  'a guest or a missing account gets no customer and no cards': async ({ pass, fail }) => {
    for(const userId of [undefined, null, '', 42]){
      const [error, made] = await ensureCustomer({ userId });
      if(error || made !== null) return fail(`${JSON.stringify(userId)} should make no customer`);
      const [, listed] = await listSavedCards({ userId });
      if(listed.methods.length) return fail(`${JSON.stringify(userId)} should list nothing`);
    }
    pass('only a signed-in account id is ever used');
  },

  'removing a card refuses a bad id, a missing account, and a card that is not theirs': async ({ pass, fail }) => {
    await disconnect();
    const cases = [
      [{ userId: '', methodId: 'pm_123' }, 401],
      [{ userId: 'user-1', methodId: 'card_123' }, 400],
      [{ userId: 'user-1', methodId: '../x' }, 400],
      [{ userId: 'user-1', methodId: undefined }, 400],
      [{ userId: 'user-1', methodId: 'pm_123' }, 404],
    ];
    for(const [input, code] of cases){
      const [error] = await removeSavedCard(input);
      if(error?.code !== code) return fail(`${JSON.stringify(input)} gave ${error?.code}, wanted ${code}`);
    }
    pass('401, 400 and 404 before the processor is asked');
  },

  'the saved-card routes need a signed-in session': async ({ pass, fail }) => {
    for(const [handler, name] of [[getSavedMethods, 'list'], [deleteSavedMethod, 'remove']]){
      const [response, out] = fakeResponse();
      await handler({ cookies: {}, params: { id: 'pm_123' } }, response);
      if(out.status !== 401) return fail(`${name} gave ${out.status} to a guest, wanted 401`);
    }
    pass('a guest gets a 401 from both, which is how the form knows to offer an account');
  },
};

export default databaseReachable
  ? suite
  : Object.fromEntries(Object.keys(suite).map(name => [name, async ({ pass }) => pass(`skipped: ${skipReason}`)]));
