import { failure } from '../server/providers/stripe.js';

/*
  What a caller is handed when Stripe refuses something.

  The fixtures are messages Stripe actually returned while this was tested against a real account,
  not paraphrases — the currency one is the reason this file exists: asking for a currency the
  account cannot take returned the account's whole supported-currency list and a dashboard link.
*/

const realWarn = console.warn;
const quietly = async run => {
  const logged = [];
  console.warn = message => logged.push(message);
  try {
    return await run(logged);
  } finally {
    console.warn = realWarn;
  }
};

const CURRENCY = `Invalid currency: kwd. You can change your account to process transactions in kwd by adding a bank account for this currency at https://dashboard.stripe.com/account. Your account currently supports these currencies: ${Array.from({ length: 140 }, (_, index) => `c${index}`).join(', ')}.`;

export default {
  /*
    A decline is the one message written for the person paying, and the second sentence is often the
    part they can act on. Shortening it would be a regression.
  */
  'a card error reaches the payer whole, second sentence included': async ({ pass, fail }) => {
    await quietly(() => {
      const [error] = failure({ type: 'StripeCardError', statusCode: 402, message: 'Your card has insufficient funds. Try a different card.' });
      if(error.msg !== 'Your card has insufficient funds. Try a different card.') return fail(`the message was cut to "${error.msg}"`);
      if(error.code !== 402) return fail(`the status was ${error.code}`);
      pass('the whole decline message, and Stripe’s own status');
    });
  },

  'a configuration error is cut to its first sentence, and the rest is logged': async ({ pass, fail }) => {
    await quietly(logged => {
      const [error] = failure({ type: 'StripeInvalidRequestError', statusCode: 400, message: CURRENCY });

      if(error.msg !== 'Invalid currency: kwd.') return fail(`the caller was handed "${error.msg.slice(0, 80)}…"`);
      if(error.msg.includes('dashboard.stripe.com')) return fail('a dashboard link reached the caller');
      if(!logged.some(line => line.includes('supports these currencies'))) return fail('the full message was not logged for the merchant');
      pass('the caller sees one sentence; the merchant’s log keeps the whole thing');
    });
  },

  'a very long single sentence is capped rather than passed through': async ({ pass, fail }) => {
    await quietly(() => {
      const [error] = failure({ type: 'StripeInvalidRequestError', statusCode: 400, message: 'x'.repeat(2000) });
      if(error.msg.length > 200) return fail(`the message was ${error.msg.length} characters`);
      if(!error.msg.endsWith('…')) return fail('a truncated message should say so');
      pass('bounded, and marked as cut');
    });
  },

  'an error with no message still says something, and a bad status becomes a 502': async ({ pass, fail }) => {
    await quietly(() => {
      const [error] = failure({ type: 'StripeConnectionError', statusCode: 0 });
      if(!error.msg) return fail('the message was empty');
      if(error.code !== 502) return fail(`a status of 0 became ${error.code}, which a caller would read as its own mistake`);

      const [odd] = failure(undefined);
      if(odd.code !== 502 || !odd.msg) return fail('a missing error object should still produce a usable answer');
      pass('never empty, and the status is always a real HTTP code');
    });
  },

  'the tuple shape is the one every caller expects': async ({ pass, fail }) => {
    await quietly(() => {
      const result = failure({ type: 'StripeCardError', statusCode: 402, message: 'declined' });
      if(!Array.isArray(result) || result.length !== 2 || result[1] !== null) return fail('expected [{ code, msg }, null]');
      pass('[{ code, msg }, null]');
    });
  },
};
