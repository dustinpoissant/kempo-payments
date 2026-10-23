import { eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoPaymentCustomer } from '../../db/schema.js';
import { activeProvider } from '../../providers/index.js';
import { readConfig } from '../config/settings.js';

/*
  Saved cards: a signed-in customer's card is kept by the processor against a customer record, and this
  extension remembers only which processor customer is whose.

  - The customer is made the first time a signed-in customer pays (see createPayment), not for everyone.
  - The account always comes from the caller's session, never from a request, so one person can never
    list or remove another's cards.
  - A payment method id is checked against the customer before it is removed (see the provider).
  - Off with the `save_cards` setting: nothing is made, listed or saved, and existing customers are left alone.
*/
const METHOD_ID = /^pm_[A-Za-z0-9_]+$/;

const keyFor = ({ provider, livemode, userId }) => `${provider}:${livemode ? 'live' : 'test'}:${userId}`;

const providerAndMode = async () => {
  const [providerError, provider] = await activeProvider();
  if(providerError) return [providerError, null];
  if(!provider.createCustomer || !provider.listSavedMethods) return [null, null];
  const [statusError, status] = await provider.status();
  if(statusError) return [statusError, null];
  if(!status.configured) return [null, null];
  return [null, { provider, livemode: Boolean(status.livemode) }];
};

const findCustomer = async ({ provider, livemode, userId }) => {
  const [row] = await db.select().from(kempoPaymentCustomer).where(eq(kempoPaymentCustomer.id, keyFor({ provider: provider.name, livemode, userId }))).limit(1);
  return row ?? null;
};

/*
  The processor customer for this account, made if there is none. Resolves to [null, ref], or [null, null]
  when saving cards is off or the processor cannot do it. A failure is an error, and createPayment treats
  it as "no saved cards for this payment" rather than a payment that cannot be made.
*/
export const ensureCustomer = async ({ userId, email = null } = {}) => {
  if(typeof userId !== 'string' || !userId) return [null, null];
  const config = await readConfig();
  if(!config.saveCards) return [null, null];

  const [error, found] = await providerAndMode();
  if(error || !found) return [error, null];
  const { provider, livemode } = found;

  const existing = await findCustomer({ provider, livemode, userId });
  if(existing) return [null, existing.providerRef];

  const id = keyFor({ provider: provider.name, livemode, userId });
  const [createError, customer] = await provider.createCustomer({ email, userId, idempotencyKey: `customer:${id}` });
  if(createError) return [createError, null];

  try {
    await db.insert(kempoPaymentCustomer).values({ id, userId, provider: provider.name, livemode, providerRef: customer.ref, createdAt: new Date() }).onConflictDoNothing();
    const stored = await findCustomer({ provider, livemode, userId });
    return [null, stored?.providerRef ?? customer.ref];
  } catch {
    return [{ code: 500, msg: 'Could not record the customer' }, null];
  }
};

/* The saved cards of an account, newest first, and whether saving is on at all. Never makes a customer. */
export const listSavedCards = async ({ userId } = {}) => {
  const config = await readConfig();
  if(!config.saveCards || typeof userId !== 'string' || !userId) return [null, { enabled: false, methods: [] }];

  const [error, found] = await providerAndMode();
  if(error) return [error, null];
  if(!found) return [null, { enabled: false, methods: [] }];

  const customer = await findCustomer({ ...found, userId });
  if(!customer) return [null, { enabled: true, methods: [] }];

  const [listError, methods] = await found.provider.listSavedMethods(customer.providerRef);
  return listError ? [listError, null] : [null, { enabled: true, methods }];
};

/* Removes one saved card of an account. A card that is not that account's is a 404, whoever asks. */
export const removeSavedCard = async ({ userId, methodId } = {}) => {
  if(typeof userId !== 'string' || !userId) return [{ code: 401, msg: 'Sign in first' }, null];
  if(typeof methodId !== 'string' || !METHOD_ID.test(methodId)) return [{ code: 400, msg: 'That is not a saved card' }, null];

  const [error, found] = await providerAndMode();
  if(error) return [error, null];
  if(!found || !found.provider.removeSavedMethod) return [{ code: 404, msg: 'That card is not saved on your account' }, null];

  const customer = await findCustomer({ ...found, userId });
  if(!customer) return [{ code: 404, msg: 'That card is not saved on your account' }, null];

  return found.provider.removeSavedMethod(customer.providerRef, methodId);
};
