import * as stripe from './stripe.js';
import { getSetting } from 'kempo/server/sdk.js';
import { DEFAULTS } from '../utils/config/settings.js';

/*
  The registry, and the contract a processor module implements.

  Only Stripe ships today. The abstraction is here anyway, and from the first commit rather than
  the day a second processor is wanted, because the alternative is that every call site grows a
  direct dependency on one company's SDK and adding PayPal becomes a change to the whole extension
  instead of a file in this directory.

  A provider module exports:

  | Export             | Shape                                                                    |
  |--------------------|--------------------------------------------------------------------------|
  | `name`             | the id stored on every payment row, and the last URL segment of its webhook |
  | `label`            | what a human is shown                                                     |
  | `webhookPath`      | the site path its events should be sent to                                |
  | `webhookEvents`    | the events that endpoint needs subscribed, for the settings screen to list |
  | `signatureHeader`  | the request header its webhook signature arrives in                       |
  | `credentialFields` | the settings holding its credentials, in the order a screen shows them     |
  | `status()`         | `[err, { configured, mode, livemode, … }]` — is it usable, and in which mode |
  | `clientConfig()`   | `[err, { publishableKey }]` — the part of the config a browser may hold    |
  | `createIntent()`   | `[err, { ref, status, clientSecret, … }]`                                 |
  | `retrieveIntent()` | `[err, { ref, status, … }]`                                               |
  | `capture()`        | `[err, { ref, status, … }]`                                               |
  | `cancel()`         | `[err, { ref, status, … }]`                                               |
  | `refund()`         | `[err, { ref, amount, status, … }]`                                       |
  | `listRefunds()`    | optional: `[err, [{ ref, amount, status, … }]]` — every refund on a payment |
  | `verifyEvent()`    | `[err, event]` — reject anything not signed by the provider               |
  | `interpretEvent()` | `{ kind: 'payment' \| 'refund' \| 'dispute' \| 'ignored', … }`            |

  Statuses coming out of any of these are kempo's, not the provider's — see
  server/utils/payments/statuses.js. Mapping is the provider module's job precisely so that the
  rest of the extension has one vocabulary rather than one per processor.

  Roadmap processors — PayPal, Square, Mollie, Amazon Pay — each become one more file here. Wallet
  and buy-now-pay-later methods (Apple Pay, Google Pay, Klarna, Afterpay, Affirm) are deliberately
  *not* providers: Stripe's payment form offers them already, so modelling them separately would
  duplicate an integration that is already done.
*/

const PROVIDERS = new Map([[stripe.name, stripe]]);

export const listProviders = () => [...PROVIDERS.values()].map(provider => ({
  name: provider.name,
  label: provider.label,
  webhookPath: provider.webhookPath,
  webhookEvents: provider.webhookEvents || [],
  credentialFields: provider.credentialFields,
}));

/*
  Which request header a provider's webhook signature arrives in. The webhook route asks rather
  than knowing, so a second processor's header comes with its module instead of being one more
  fallback in an ever-growing `||` chain.
*/
export const signatureHeaderFor = name => PROVIDERS.get(name)?.signatureHeader || null;

export const getProvider = name => {
  const provider = PROVIDERS.get(name);
  if(!provider) return [{ code: 400, msg: `No payment provider named "${name}" is installed` }, null];
  return [null, provider];
};

/*
  The provider a payment should be taken through right now.

  Read fresh from settings on every call rather than cached, because the alternative is that
  switching processors appears to work and then keeps sending money to the old one until somebody
  restarts the server.
*/
export const activeProvider = async () => {
  const [error, configured] = await getSetting('kempo-payments', 'provider', DEFAULTS.provider);
  return getProvider(error ? DEFAULTS.provider : String(configured || DEFAULTS.provider));
};

/*
  The provider a payment already went through, which is not necessarily the active one. Refunding a
  Stripe charge after the site has switched to PayPal has to go back to Stripe — the money is
  there, and asking the new processor to return it is meaningless.
*/
export const providerForPayment = payment => getProvider(payment?.provider);
