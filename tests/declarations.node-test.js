import { readFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SAVEABLE } from '../public/api/settings/PUT.js';
import { listProviders } from '../server/providers/index.js';
import { ZERO_DECIMAL, THREE_DECIMAL } from '../server/utils/money/currencies.js';

/*
  Static checks that what the code asks for is what the extension declares.

  This is the shape of bug kempo-blog shipped: its config declared prefixed permission names while
  its routes checked unprefixed ones, so its "New Post" gate silently denied everyone. A permission
  check against a name nobody registered does not error — it answers no, forever, and only for
  people who are not administrators, which is why it survives manual testing.

  Here the same class of drift is worse in two specific places, and both have a check below:

  - A credential written without its declared `secret` type is an **API key stored in plain text**,
    in a row kempo's own settings screen shows to anyone who can open it.
  - An index this extension relies on but never creates exists only in development, where
    `drizzle-kit push` makes it. kempo's installer creates tables and primary keys and nothing else.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'kempo-config.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const walk = async dir => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for(const entry of entries){
    if(entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if(entry.isDirectory()) files.push(...await walk(full));
    else if(entry.name.endsWith('.js')) files.push(full);
  }
  return files;
};

const sources = [
  ...await walk(path.join(root, 'public')),
  ...await walk(path.join(root, 'server')),
  ...await walk(path.join(root, 'admin')),
];

const contents = new Map(await Promise.all(sources.map(async file => [file, await readFile(file, 'utf8')])));
const allText = [...contents.values()].join('\n');
const pageText = await readFile(path.join(root, 'admin', 'index.page.html'), 'utf8');

export default {
  'every permission the code checks is one the extension declares': async ({ pass, fail }) => {
    const declared = new Set(config.permissions.map(permission => permission.name));

    for(const [file, text] of contents){
      for(const match of text.matchAll(/['"](payments:[a-z:]+)['"]/g)){
        if(!declared.has(match[1])){
          return fail(`${path.relative(root, file)} checks "${match[1]}", which nothing declares`);
        }
      }
    }

    for(const match of pageText.matchAll(/has="(payments:[a-z:]+)"/g)){
      if(!declared.has(match[1])) return fail(`the admin page gates on "${match[1]}", which nothing declares`);
    }

    pass(`all ${declared.size} declared permissions are the ones the code uses`);
  },

  'every declared permission is actually enforced somewhere': async ({ pass, fail }) => {
    for(const { name } of config.permissions){
      if(!allText.includes(`'${name}'`) && !allText.includes(`"${name}"`)){
        return fail(`"${name}" is declared but no route checks it — it grants nothing`);
      }
    }
    pass('no permission is decoration');
  },

  'the groups only grant permissions that exist': async ({ pass, fail }) => {
    const declared = new Set(config.permissions.map(permission => permission.name));
    for(const group of config.groups){
      for(const name of group.permissions){
        if(!declared.has(name)) return fail(`${group.name} grants "${name}", which is not declared`);
      }
    }
    pass('every group grant resolves');
  },

  /*
    The check that matters most in this extension. `secret` is what makes a credential encrypted at
    rest and excluded from every public read — a field the settings route writes without it becomes
    an API key in plain text.
  */
  'every credential a provider needs is declared as a secret, except the public one': async ({ pass, fail }) => {
    const declared = new Map(config.settings.map(setting => [setting.name, setting]));

    for(const provider of listProviders()){
      for(const field of provider.credentialFields){
        const setting = declared.get(field.name);
        if(!setting) return fail(`${provider.name} needs "${field.name}", which kempo-config.json does not declare`);
        if(setting.type !== field.type){
          return fail(`"${field.name}" is declared as ${setting.type} but the provider calls it ${field.type}`);
        }
        if(field.type !== 'secret' && !field.name.includes('publishable')){
          return fail(`"${field.name}" is not a secret and is not a publishable key — check that is deliberate`);
        }
      }
    }
    pass('credentials are typed the way they are stored');
  },

  'the settings route can only write settings that are declared': async ({ pass, fail }) => {
    const declared = new Set(config.settings.map(setting => setting.name));
    for(const name of SAVEABLE){
      if(!declared.has(name)) return fail(`the settings route writes "${name}", which is not declared`);
    }
    for(const { name } of config.settings){
      if(!SAVEABLE.includes(name)) return fail(`"${name}" is declared but its own screen cannot edit it`);
    }
    pass(`all ${SAVEABLE.length} settings are declared and editable`);
  },

  /*
    kempo's installer creates columns and primary keys from a Drizzle schema and nothing else, so
    every index declared there has to be created by hand in install.js. The unique one is not a
    performance detail: without it two rows can claim the same charge.
  */
  'every index the schema declares is one install.js creates': async ({ pass, fail }) => {
    const schema = await readFile(path.join(root, 'server', 'db', 'schema.js'), 'utf8');
    const install = await readFile(path.join(root, 'install.js'), 'utf8');

    const declared = [...schema.matchAll(/\b(uniqueIndex|index)\('([^']+)'\)/g)];
    if(!declared.length) return fail('the schema declares no indexes — has one been dropped?');

    for(const [, kind, name] of declared){
      if(!install.includes(`"${name}"`)){
        return fail(`"${name}" is declared in the schema but install.js never creates it`);
      }
      if(kind === 'uniqueIndex' && !new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS "${name}"`).test(install)){
        return fail(`"${name}" is unique in the schema but install.js creates it non-unique`);
      }
    }
    pass(`all ${declared.length} declared indexes are created at install time`);
  },

  /*
    The browser cannot import the server's copy — it reaches into kempo's server SDK — so there are
    two lists of which currencies have no minor unit. The day they disagree is the day a screen
    shows ¥1,200 as ¥12.00.
  */
  'the browser and the server agree on which currencies have no minor unit': async ({ pass, fail }) => {
    const browser = await import('../public/utils/money.js');

    for(const [name, [server, client]] of Object.entries({
      'zero-decimal': [ZERO_DECIMAL, browser.ZERO_DECIMAL],
      'three-decimal': [THREE_DECIMAL, browser.THREE_DECIMAL],
    })){
      if(server.size !== client.size) return fail(`the ${name} lists are different sizes`);
      for(const code of server){
        if(!client.has(code)) return fail(`the browser's ${name} list is missing ${code}`);
      }
    }
    pass('both copies of the currency tables match');
  },

  'the webhook route exists at the path the provider advertises': async ({ pass, fail }) => {
    const scope = config['public-scope'];

    for(const provider of listProviders()){
      const expected = `/${scope}/api/webhooks/${provider.name}`;
      if(provider.webhookPath !== expected){
        return fail(`${provider.name} advertises ${provider.webhookPath}, but its scope makes it ${expected}`);
      }
    }

    const routes = await walk(path.join(root, 'public', 'api', 'webhooks'));
    if(!routes.some(file => file.endsWith('POST.js'))){
      return fail('nothing answers a webhook — the route directory has no POST handler');
    }
    pass('the endpoint shown on the settings screen is the one that exists');
  },

  'the public scope is the same in both places it is declared': async ({ pass, fail }) => {
    if(pkg.kempo?.['public-scope'] !== config['public-scope']){
      return fail(`package.json says "${pkg.kempo?.['public-scope']}" and kempo-config.json says "${config['public-scope']}"`);
    }
    /*
      Browser code imports by absolute URL, so a scope change that misses one of them is a 404 in
      the browser and nothing at all at build time.
    */
    for(const [file, text] of contents){
      for(const match of text.matchAll(/from '\/([a-z-]+)\/(?:sdk\.js|utils|components)/g)){
        if(match[1] !== config['public-scope'] && match[1] !== 'kempo-ui' && match[1] !== 'kempo'){
          return fail(`${path.relative(root, file)} imports from /${match[1]}/, which is not this extension's scope`);
        }
      }
    }
    pass(`everything is served under /${config['public-scope']}/`);
  },

  'the admin components are loaded from this extension’s own admin path': async ({ pass, fail }) => {
    for(const match of pageText.matchAll(/src="\/admin\/extension\/([a-z-]+)\//g)){
      if(match[1] !== pkg.name) return fail(`the admin page loads from /admin/extension/${match[1]}/`);
    }
    pass('no cross-extension component imports');
  },
};
