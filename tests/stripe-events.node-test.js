import * as stripe from '../server/providers/stripe.js';

/*
  How Stripe's events become things this extension acts on.

  Pure translation, no network — which is the point of `interpretEvent` being a separate function.
  A payload shape that changes, or an event type that stops being handled, shows up here rather
  than in production as a payment that silently never left "Processing".
*/

const event = (type, object) => ({ id: `evt_${type}`, type, data: { object } });

export default {
  'a succeeded intent is a payment update': async ({ pass, fail }) => {
    const result = stripe.interpretEvent(event('payment_intent.succeeded', {
      id: 'pi_123',
      status: 'succeeded',
      amount: 5000,
      amount_received: 5000,
      currency: 'usd',
      capture_method: 'automatic',
      livemode: false,
    }));

    if(result.kind !== 'payment') return fail(`kind was ${result.kind}`);
    if(result.providerRef !== 'pi_123') return fail('the intent id is the reference to match on');
    if(result.payment.status !== 'succeeded') return fail(`status was ${result.payment.status}`);
    if(result.payment.amountCaptured !== 5000) return fail('the received amount is what was captured');
    pass('the row can be brought up to date from it');
  },

  /*
    The one that would go unnoticed. Stripe leaves a failed intent in `requires_payment_method` so
    the customer can try another card, so nothing in the status says anything went wrong — the
    message is the only record that a card was declined.
  */
  'a failed payment carries its decline message': async ({ pass, fail }) => {
    const result = stripe.interpretEvent(event('payment_intent.payment_failed', {
      id: 'pi_124',
      status: 'requires_payment_method',
      amount: 5000,
      amount_received: 0,
      currency: 'usd',
      capture_method: 'automatic',
      last_payment_error: { message: 'Your card was declined.' },
    }));

    if(result.kind !== 'payment') return fail(`kind was ${result.kind}`);
    if(result.payment.lastError !== 'Your card was declined.'){
      return fail(`the decline message was ${JSON.stringify(result.payment.lastError)}`);
    }
    pass('a decline is visible even though the status is unchanged');
  },

  'an authorisation awaiting capture is recognised': async ({ pass, fail }) => {
    const result = stripe.interpretEvent(event('payment_intent.amount_capturable_updated', {
      id: 'pi_125',
      status: 'requires_capture',
      amount: 5000,
      amount_received: 0,
      currency: 'usd',
      capture_method: 'manual',
    }));

    if(result.payment.status !== 'requires_capture') return fail(`status was ${result.payment.status}`);
    if(result.payment.captureMethod !== 'manual') return fail('the capture method comes across');
    pass('a hold is reported as one');
  },

  'a refunded charge reports every refund on it': async ({ pass, fail }) => {
    const result = stripe.interpretEvent(event('charge.refunded', {
      id: 'ch_1',
      payment_intent: 'pi_126',
      amount_refunded: 2000,
      refunds: { data: [{ id: 're_1', amount: 2000, currency: 'usd', status: 'succeeded', reason: 'requested_by_customer' }] },
    }));

    if(result.kind !== 'refund') return fail(`kind was ${result.kind}`);
    if(result.providerRef !== 'pi_126') return fail('a refund is matched by its intent, not its charge');
    if(result.refunds.length !== 1 || result.refunds[0].ref !== 're_1') return fail('the refund itself is carried');
    pass('refunds are keyed by the processor’s own id, which is what makes them deduplicable');
  },

  /*
    What Stripe actually sends now. The fixture above is the old shape, with the refunds listed
    inline; on the current API version (checked against a real event, 2026-07-29.dahlia) the charge
    has no `refunds` key at all and the event says only that the total is now 100. Read as "no
    refunds", that was recorded as handled and changed nothing. The empty list has to reach the
    webhook as an empty list — it is what tells it to go and ask — and the total has to survive.
  */
  'a refunded charge with no refund list says so instead of pretending there were none': async ({ pass, fail }) => {
    const result = stripe.interpretEvent(event('charge.refunded', {
      id: 'ch_2',
      payment_intent: 'pi_129',
      amount: 500,
      amount_refunded: 100,
    }));

    if(result.kind !== 'refund') return fail(`kind was ${result.kind}`);
    if(result.refunds.length) return fail('refunds were invented from nothing');
    if(result.amountRefunded !== 100) return fail(`the new total was lost: ${result.amountRefunded}`);
    if(typeof stripe.listRefunds !== 'function') return fail('nothing exists to ask Stripe which refunds make up the total');
    pass('an empty list and a total, which is the cue to fetch the refunds');
  },

  /*
    A free-text reason is stored in metadata because Stripe only accepts three of its own. Reading
    it back out is what stops it being lost on the round trip.
  */
  'a refund reason survives in metadata': async ({ pass, fail }) => {
    const result = stripe.interpretEvent(event('charge.refund.updated', {
      id: 're_2',
      payment_intent: 'pi_127',
      amount: 500,
      currency: 'usd',
      status: 'succeeded',
      metadata: { reason: 'Item arrived damaged' },
    }));

    if(result.refunds[0].reason !== 'Item arrived damaged'){
      return fail(`the reason came back as ${JSON.stringify(result.refunds[0].reason)}`);
    }
    pass('a reason Stripe would not accept is still on the record');
  },

  'a dispute opens and closes': async ({ pass, fail }) => {
    const opened = stripe.interpretEvent(event('charge.dispute.created', { payment_intent: 'pi_128', reason: 'fraudulent' }));
    if(opened.kind !== 'dispute' || opened.disputed !== true) return fail('a new dispute flags the payment');

    const won = stripe.interpretEvent(event('charge.dispute.closed', { payment_intent: 'pi_128', status: 'won' }));
    if(won.disputed !== false) return fail('a dispute won leaves the payment clean');

    const lost = stripe.interpretEvent(event('charge.dispute.closed', { payment_intent: 'pi_128', status: 'lost' }));
    if(lost.disputed !== true) return fail('a dispute lost took the money back — the flag stays');

    pass('winning clears the flag and losing does not');
  },

  'anything unrecognised is ignored rather than failed': async ({ pass, fail }) => {
    const result = stripe.interpretEvent(event('customer.subscription.created', { id: 'sub_1' }));
    if(result.kind !== 'ignored') return fail(`kind was ${result.kind}`);
    pass('an event nothing here acts on does not make the processor retry it forever');
  },

  /*
    An unexpanded `latest_charge` is a bare id string, and the charge is the only thing that knows
    the refunded total. Reporting 0 there would write over a real refund total with a wrong one.
  */
  'an unexpanded charge reports no refund total rather than zero': async ({ pass, fail }) => {
    const unexpanded = stripe.fromIntent({
      id: 'pi_129', status: 'succeeded', amount: 5000, amount_received: 5000,
      currency: 'usd', capture_method: 'automatic', latest_charge: 'ch_9',
    });
    if(unexpanded.amountRefunded !== undefined){
      return fail(`amountRefunded was ${unexpanded.amountRefunded}, which would overwrite a real total`);
    }

    const expanded = stripe.fromIntent({
      id: 'pi_130', status: 'succeeded', amount: 5000, amount_received: 5000,
      currency: 'usd', capture_method: 'automatic', latest_charge: { amount_refunded: 1500 },
    });
    if(expanded.amountRefunded !== 1500) return fail('an expanded charge does report the total');

    pass('“I do not know” and “zero” stay different answers');
  },

  'every event the settings screen tells you to subscribe to is one this code handles': async ({ pass, fail }) => {
    for(const type of stripe.webhookEvents){
      const object = type.startsWith('charge.dispute')
        ? { payment_intent: 'pi_1', status: 'lost' }
        : type.startsWith('charge.refund')
          ? { id: 're_1', payment_intent: 'pi_1', amount: 1, currency: 'usd', status: 'succeeded', refunds: { data: [] } }
          : { id: 'pi_1', status: 'succeeded', amount: 1, amount_received: 1, currency: 'usd', capture_method: 'automatic' };

      if(stripe.interpretEvent(event(type, object)).kind === 'ignored'){
        return fail(`${type} is on the subscribe list but nothing acts on it`);
      }
    }
    pass('the list on the settings screen and the switch statement agree');
  },
};
