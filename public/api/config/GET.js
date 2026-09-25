import { activeProvider } from '../../../server/providers/index.js';
import { readConfig } from '../../../server/utils/config/settings.js';

/*
  What a payment form in a browser needs to exist: which processor is configured, its publishable
  key, and the currency amounts will be in.

  The one route here with no session check, deliberately. A publishable key is designed to be
  public — it is embedded in the page for every visitor and can do nothing on its own but tokenise
  a card the person holding it already has. Gating this would mean guests cannot check out, which
  is most of the people checking out.

  Nothing secret can reach here by accident: the provider module decides what its `clientConfig` is
  allowed to contain, and the secret key is not part of it.
*/
export default async (request, response) => {
  const config = await readConfig();

  const [providerError, provider] = await activeProvider();
  if(providerError){
    return response.json({ configured: false, provider: config.provider, currency: config.currency });
  }

  const [statusError, status] = await provider.status();
  if(statusError) return response.status(statusError.code).json({ error: statusError.msg });

  if(!status.configured){
    return response.json({
      configured: false,
      provider: provider.name,
      label: provider.label,
      currency: config.currency,
    });
  }

  const [configError, clientConfig] = await provider.clientConfig();
  if(configError) return response.status(configError.code).json({ error: configError.msg });

  response.json({
    configured: true,
    provider: provider.name,
    label: provider.label,
    currency: config.currency,
    captureMethod: config.captureMethod,
    mode: status.mode,
    ...clientConfig,
  });
};
