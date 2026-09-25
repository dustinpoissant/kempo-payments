import { setSetting } from 'kempo/server/sdk.js';
import { getProvider, listProviders } from '../../../server/providers/index.js';
import { OWNER, CAPTURE_METHODS, parseCaptureMethod, readConfig } from '../../../server/utils/config/settings.js';
import { typeOf, descriptionOf, DECLARED_SETTINGS } from '../../../server/utils/config/declared.js';
import { isValidCurrency, normaliseCurrency } from '../../../server/utils/money/currencies.js';
import { gate } from '../../../server/utils/permissions/gate.js';

/*
  Saves the settings, one kempo setting per field.

  These are ordinary kempo settings and also appear under /admin/settings grouped by owner —
  nothing here is a second store. What this route adds is validation before the write, and its own
  permission: `payments:settings` can be given to whoever connects the site to its processor
  without also giving them `system:settings:update`, which is every setting on the installation.

  **Blank means unchanged, not cleared.** A secret is never sent to the browser, so the field
  showing it is always empty — saving the form after editing something else would otherwise wipe
  the site's API keys and stop it taking money. Clearing one is possible, but it takes an explicit
  `null`, which no accidental submit produces.
*/

/*
  Exported so a static test can check every name here is declared in kempo-config.json. A setting
  written without its declared type is the specific failure that matters most in this extension:
  `secret` is what makes an API key encrypted at rest, and a write that loses the type stores it as
  plain text in a row the admin settings screen will show to anyone who can open it.
*/
export const SAVEABLE = [
  'provider',
  'currency',
  'capture_method',
  ...listProviders().flatMap(provider => provider.credentialFields.map(field => field.name)),
];

export default async (request, response) => {
  const [gateError] = await gate(request, 'payments:settings');
  if(gateError) return response.status(gateError.code).json({ error: gateError.msg });

  if(!process.env.SETTINGS_ENCRYPTION_KEY){
    return response.status(500).json({
      error: 'SETTINGS_ENCRYPTION_KEY is not set on this server, so API credentials cannot be stored. Add it to the environment and restart.',
    });
  }

  const body = request.body || {};
  const updates = {};

  if(body.provider !== undefined){
    const [error] = getProvider(String(body.provider));
    if(error) return response.status(400).json({ error: error.msg });
    updates.provider = String(body.provider);
  }

  if(body.currency !== undefined){
    const currency = normaliseCurrency(body.currency);
    if(!isValidCurrency(currency)){
      return response.status(400).json({ error: 'Currency must be a three-letter ISO code, such as usd or gbp' });
    }
    updates.currency = currency;
  }

  if(body.capture_method !== undefined){
    const method = parseCaptureMethod(body.capture_method);
    if(!method){
      return response.status(400).json({ error: `Capture method must be one of: ${CAPTURE_METHODS.join(', ')}` });
    }
    updates.capture_method = method;
  }

  for(const provider of listProviders()){
    for(const field of provider.credentialFields){
      const value = body[field.name];
      if(value === undefined) continue;

      // The deliberate clear. Anything else empty is a form that simply had nothing typed in it.
      if(value === null){
        updates[field.name] = '';
        continue;
      }

      const trimmed = String(value).trim();
      if(!trimmed) continue;

      /*
        The one paste that has to be refused rather than warned about. A secret key in the
        publishable field would be handed to every visitor's browser by the config route, and by
        the time anybody noticed it would have to be treated as compromised and rotated.
      */
      if(field.type !== 'secret' && /^(sk|rk)_/.test(trimmed)){
        return response.status(400).json({
          error: `That looks like a secret key, not a ${field.label.toLowerCase()}. It would be sent to every visitor’s browser — check you have the right one.`,
        });
      }

      updates[field.name] = trimmed;
    }
  }

  if(!Object.keys(updates).length){
    return response.status(400).json({ error: 'Nothing to save' });
  }

  for(const [name, value] of Object.entries(updates)){
    // Belt and braces: nothing reaches setSetting that is not on the list above.
    if(!SAVEABLE.includes(name) || !DECLARED_SETTINGS.has(name)) continue;

    /*
      The type and description come from kempo-config.json rather than being restated here.
      setSetting stores exactly what it is handed, so passing null for the description would erase
      the text kempo's own /admin/settings screen shows next to each of these.

      isPublic stays false throughout, and setSetting forces it false for a secret regardless.
    */
    const [error] = await setSetting(OWNER, name, value, typeOf(name), false, descriptionOf(name));
    if(error) return response.status(error.code).json({ error: error.msg });
  }

  const config = await readConfig();
  const [providerError, provider] = getProvider(config.provider);
  const status = providerError ? null : (await provider.status())[1];

  response.json({ settings: config, status });
};
