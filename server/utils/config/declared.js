import { createRequire } from 'module';

/*
  The declared settings, read from kempo-config.json itself.

  This exists so the settings route can preserve each setting's type and description when it
  writes. `setSetting` takes both as arguments and stores exactly what it is given — pass null and
  the description shown on kempo's own /admin/settings screen is erased, which is how a perfectly
  working save quietly degrades a screen belonging to somebody else.

  The type matters more here than in most extensions: writing a credential without `secret` stores
  an API key as plain text, in a row the admin settings screen will happily show to anybody who can
  open it. Reading the type out of the config rather than restating it means there is one list, and
  a static test checks the two agree.
*/
const require = createRequire(import.meta.url);
const config = require('../../../kempo-config.json');

export const DECLARED_SETTINGS = new Map(
  (config.settings || []).map(setting => [setting.name, setting]),
);

export const typeOf = name => DECLARED_SETTINGS.get(name)?.type || 'string';
export const descriptionOf = name => DECLARED_SETTINGS.get(name)?.description || null;
export const isSecret = name => typeOf(name) === 'secret';
