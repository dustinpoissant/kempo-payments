import crypto from 'crypto';

/*
  The manual procedure for payments on a connected account, against Stripe's **test mode**.

  `npm test` never talks to Stripe, so the calls that only mean something at Stripe — an intent made
  on another account, its application fee, a refund that gives the fee back — are proved here
  instead, by running this extension's own code (not a copy of it) against a real test-mode Connect
  account. It needs nothing installed: the database is an in-memory Postgres, thrown away at the end.

    STRIPE_TEST_SECRET_KEY=sk_test_… STRIPE_TEST_PUBLISHABLE_KEY=pk_test_… node scripts/connect-test-mode.js

  The platform account behind the key must have Connect enabled and at least one connected account
  that can take card payments; set STRIPE_TEST_CONNECTED_ACCOUNT=acct_… to choose which. The charges
  and refunds it makes are test-mode objects and are left in place. Anything that is not a test key is
  refused before a single call is made.
*/

const secretKey = process.env.STRIPE_TEST_SECRET_KEY || '';
const publishableKey = process.env.STRIPE_TEST_PUBLISHABLE_KEY || '';
if(!secretKey.startsWith('sk_test_') || !publishableKey.startsWith('pk_test_')){
  console.error('Set STRIPE_TEST_SECRET_KEY and STRIPE_TEST_PUBLISHABLE_KEY to test-mode keys. Live keys are refused.');
  process.exit(2);
}

process.env.KEMPO_DB = 'pglite';
process.env.SETTINGS_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('hex');

const { default: Stripe } = await import('stripe');
const { setSetting } = await import('kempo/server/sdk.js');
const payments = await import('../sdk.js');

const stripe = new Stripe(secretKey);
await setSetting('kempo-payments', 'stripe_secret_key', secretKey, 'secret', false, 'test-mode procedure');
await setSetting('kempo-payments', 'stripe_publishable_key', publishableKey, 'string', false, 'test-mode procedure');

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

/*
  A connected account that can already take a card charge. Creating one is kempo-payouts' job (and
  Stripe now only creates them through Accounts v2), so this uses the one it is given, or the first
  account on the platform whose card payments are active — a test-mode platform normally has sample
  accounts that qualify. What is proved here does not depend on how the account was set up.
*/
const testAccount = async () => {
  if(process.env.STRIPE_TEST_CONNECTED_ACCOUNT) return process.env.STRIPE_TEST_CONNECTED_ACCOUNT;
  for await (const account of stripe.accounts.list({ limit: 100 })){
    if(account.charges_enabled && account.capabilities?.card_payments === 'active') return account.id;
  }
  throw new Error('No connected account on this platform can take card payments yet. Onboard one, or set STRIPE_TEST_CONNECTED_ACCOUNT.');
};

const confirm = (payment, account) => stripe.paymentIntents.confirm(payment.providerRef, { payment_method: 'pm_card_visa', return_url: 'https://example.com/return' }, { stripeAccount: account });

const feeFor = async (payment, account) => {
  const intent = await stripe.paymentIntents.retrieve(payment.providerRef, { expand: ['latest_charge'] }, { stripeAccount: account });
  const feeId = typeof intent.latest_charge?.application_fee === 'string' ? intent.latest_charge.application_fee : intent.latest_charge?.application_fee?.id;
  return feeId ? stripe.applicationFees.retrieve(feeId) : null;
};

try {
  const account = await testAccount();
  console.log(`connected account: ${account}`);

  // 1. Create, on the account, with a fee.
  const [createError, created] = await payments.createPayment({ amount: 1000, currency: 'usd', connectedAccount: account, applicationFee: 50, owner: 'connect-test-mode', reference: 'one' });
  check('createPayment makes the intent on the connected account', !createError && created.payment.connectedAccount === account, createError?.msg);
  const remote = await stripe.paymentIntents.retrieve(created.payment.providerRef, {}, { stripeAccount: account });
  check('the intent carries the application fee', remote.application_fee_amount === 50, `application_fee_amount ${remote.application_fee_amount}`);
  const missing = await stripe.paymentIntents.retrieve(created.payment.providerRef).then(() => true, () => false);
  check('the intent is not on the platform (so the account header is load-bearing)', !missing);

  // 2. Retrieve (through sync) after the customer pays.
  await confirm(created.payment, account);
  const [syncError, synced] = await payments.syncPayment(created.payment.id);
  check('syncPayment reads the intent from the account', !syncError && synced.payment.status === 'succeeded', syncError?.msg || synced?.payment.status);
  const fee = await feeFor(created.payment, account);
  check('the site received its fee', fee?.amount === 50, `fee ${fee?.amount}`);

  // 3. Refund with the fee (the default), then without it.
  const [refundError] = await payments.refundPayment(created.payment.id, { amount: 400, reason: 'test-mode procedure' });
  const afterFirst = await feeFor(created.payment, account);
  check('a refund gives the fee back in proportion by default', !refundError && afterFirst?.amount_refunded === 20, refundError?.msg || `fee refunded ${afterFirst?.amount_refunded}`);
  const [keepError] = await payments.refundPayment(created.payment.id, { amount: 200, refundApplicationFee: false });
  const afterSecond = await feeFor(created.payment, account);
  check('refundApplicationFee: false keeps the fee', !keepError && afterSecond?.amount_refunded === 20, keepError?.msg || `fee refunded ${afterSecond?.amount_refunded}`);
  const key = `connect-test-mode-${Date.now()}`;
  const [firstKeyed] = await payments.refundPayment(created.payment.id, { amount: 100, idempotencyKey: key });
  const [secondKeyed] = await payments.refundPayment(created.payment.id, { amount: 100, idempotencyKey: key });
  const [, resynced] = await payments.syncPayment(created.payment.id);
  const [, refunds] = await payments.listRefunds(created.payment.id);
  check('a refund retried with the same idempotency key is made once', !firstKeyed && !secondKeyed && resynced?.payment.amountRefunded === 700, `refunded ${resynced?.payment.amountRefunded}`);
  check('listRefunds (through sync) reads every refund from the account', refunds?.length === 3, `${refunds?.length} refunds`);

  // 4. Capture a held payment.
  const [, held] = await payments.createPayment({ amount: 800, currency: 'usd', connectedAccount: account, applicationFee: 30, captureMethod: 'manual' });
  await confirm(held.payment, account);
  await payments.syncPayment(held.payment.id);
  const [captureError, captured] = await payments.capturePayment(held.payment.id);
  check('capturePayment captures on the account', !captureError && captured.payment.status === 'succeeded', captureError?.msg || captured?.payment.status);

  // 5. Cancel one nobody paid.
  const [, abandoned] = await payments.createPayment({ amount: 700, currency: 'usd', connectedAccount: account, applicationFee: 0 });
  const [cancelError, canceled] = await payments.cancelPayment(abandoned.payment.id);
  check('cancelPayment cancels on the account', !cancelError && canceled.payment.status === 'canceled', cancelError?.msg || canceled?.payment.status);

  const [secretError, resumed] = await payments.getClientSecret(held.payment.id);
  check('getClientSecret returns the account with the secret', !secretError && resumed.connectedAccount === account && !!resumed.clientSecret);

  /*
    6. A real event, in the shape Stripe sends it today, through the entry point kempo-payouts uses.
    Read back from the account's own event list rather than written by hand — a hand-written fixture
    is how a payload change went unnoticed here once before.
  */
  const [, fresh] = await payments.createPayment({ amount: 600, currency: 'usd', connectedAccount: account, applicationFee: 30 });
  await confirm(fresh.payment, account);
  let event = null;
  for(let attempt = 0; attempt < 10 && !event; attempt++){
    const listed = await stripe.events.list({ type: 'payment_intent.succeeded', limit: 20 }, { stripeAccount: account });
    event = listed.data.find(item => item.data.object.id === fresh.payment.providerRef) || null;
    if(!event) await new Promise(resolve => setTimeout(resolve, 1500));
  }
  check('Stripe recorded the event on the account', !!event);
  if(event){
    console.log(`      the listed event ${event.account ? `names its account (${event.account})` : 'has no account field; a webhook delivery does — added here as the webhook would carry it'}`);
    const [eventError, applied] = await payments.receiveVerifiedEvent({ event: { ...event, account: event.account || account } });
    const [, after] = await payments.getPayment(fresh.payment.id);
    check('receiveVerifiedEvent applies the real event', !eventError && applied.handled && after.status === 'succeeded', eventError?.msg || JSON.stringify(applied));
  }
} catch(error) {
  check('the procedure ran to the end', false, error.message);
}

const failed = results.filter(ok => !ok).length;
console.log(`\n${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);
