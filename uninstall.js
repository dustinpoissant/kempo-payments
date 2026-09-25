import { listPayments } from './server/utils/payments/store.js';

/*
  Nothing here is deleted, and nothing here can be.

  kempo drops this extension's three tables straight after this runs, which loses the site's record
  of every payment it has ever taken. That record is a copy: the money, the charges and the refunds
  all live at the processor, and they are entirely unaffected by anything happening on this server.
  Reinstalling does not bring the rows back, but the processor's dashboard has never stopped having
  them, and a payment can always be refunded there.

  What this does is say so, loudly enough that somebody clicking uninstall on a site that has taken
  real money knows what they are about to lose before they lose it — because there is no undo
  anywhere in this stack, and "how much did we take last quarter" is a question that gets asked
  months after the extension was removed.

  Outstanding authorisations are called out separately. Those are holds on real customers' cards
  that nothing will ever capture or release once this extension is gone; they expire on their own
  after a week or so, but a customer looking at their statement in the meantime sees money missing.
*/
export default async () => {
  const [error, data] = await listPayments({ limit: 200 });
  if(error) return;

  const uncaptured = data.payments.filter(payment => payment.status === 'requires_capture');

  console.log(`[kempo-payments] Removing. ${data.total} payment record${data.total === 1 ? '' : 's'} will be dropped with the tables — the charges themselves are unaffected and remain in the processor's dashboard.`);

  if(uncaptured.length){
    console.warn(`[kempo-payments] ${uncaptured.length} payment${uncaptured.length === 1 ? ' is' : 's are'} authorised but not captured. Capture or cancel ${uncaptured.length === 1 ? 'it' : 'them'} in the processor's dashboard — nothing here will be able to once this is gone:`);
    for(const payment of uncaptured){
      console.warn(`  ${payment.provider} ${payment.providerRef} — ${payment.amount} ${payment.currency.toUpperCase()}`);
    }
  }
};
