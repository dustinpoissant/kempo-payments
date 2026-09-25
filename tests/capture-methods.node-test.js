import { CAPTURE_METHODS, DEFAULTS, normaliseCaptureMethod, parseCaptureMethod } from '../server/utils/config/settings.js';
import { createPayment } from '../server/utils/payments/create.js';
import { databaseReachable, skipReason } from './testDatabase.js';

/*
  "Charge now" versus "hold for later".

  These are opposites, and a payment library must never let a mistyped one turn into the other.
  It did: `createPayment` fed a caller's capture method through a fallback that mapped every
  unrecognised value to `automatic`, so against Stripe every spelling except the exact lowercase
  `manual` — `Manual`, `MANUAL `, `hold`, `authorize`, a typo — placed an immediate charge on a card
  when the caller meant only to reserve it. The spellings below are the ones that did.
*/

const MEANT_TO_HOLD = ['Manual', 'MANUAL ', ' manual', 'manual\n'];
const NOT_A_METHOD = ['manaul', 'hold', 'authorize', 'authorise', 'later', 'auto', 'true', '0'];

export default {
  'parseCaptureMethod forgives case and spaces and nothing else': async ({ pass, fail }) => {
    for(const spelling of MEANT_TO_HOLD){
      if(parseCaptureMethod(spelling) !== 'manual') return fail(`${JSON.stringify(spelling)} was not read as manual`);
    }
    if(parseCaptureMethod(' Automatic ') !== 'automatic') return fail('"Automatic" was not read as automatic');

    for(const spelling of NOT_A_METHOD){
      if(parseCaptureMethod(spelling) !== null) return fail(`${JSON.stringify(spelling)} was guessed at instead of refused`);
    }
    for(const value of [undefined, null, '', '   ', 0, 1, true, {}, [], ['manual']]){
      if(parseCaptureMethod(value) !== null) return fail(`${JSON.stringify(value)} was accepted`);
    }
    pass('every spelling of the two real ones, and null for everything else');
  },

  'the fallback is only for a stored site default, and never lands on a charge by accident': async ({ pass, fail }) => {
    if(normaliseCaptureMethod('manaul') !== DEFAULTS.captureMethod) return fail('an unreadable stored value should fall back to the default');
    if(normaliseCaptureMethod('Manual') !== 'manual') return fail('a stored "Manual" should be read as manual, not thrown away for the default');
    if(!CAPTURE_METHODS.includes(DEFAULTS.captureMethod)) return fail('the default is not one of the methods');
    pass('an unreadable stored setting degrades to the default; a readable one is respected');
  },

  /*
    The check that would have caught it. The refusal happens before settings are read or a provider
    is contacted, so this needs neither a database nor a processor: a request that got past
    capture-method validation would have gone on to one and not come back as a 400.
  */
  'createPayment refuses a capture method it does not recognise, before contacting a provider': async ({ pass, fail }) => {
    for(const captureMethod of NOT_A_METHOD){
      const [error, result] = await createPayment({ amount: 1000, currency: 'usd', captureMethod });

      if(result) return fail(`${JSON.stringify(captureMethod)} produced a payment — the card would have been charged`);
      if(error?.code !== 400) return fail(`${JSON.stringify(captureMethod)} got ${error?.code} (${error?.msg}) instead of a 400 — the refusal comes too late or not at all`);
      if(!/capture method/i.test(error.msg)) return fail(`the message does not say what was wrong: ${error.msg}`);
    }
    pass(`${NOT_A_METHOD.length} spellings refused with a 400 that names the problem`);
  },

  'a recognisable spelling gets past validation rather than being refused': async ({ pass, fail }) => {
    if(!databaseReachable) return pass(`skipped: ${skipReason} — this one goes on to read settings and a provider`);

    for(const captureMethod of MEANT_TO_HOLD){
      const [error] = await createPayment({ amount: 1000, currency: 'usd', captureMethod });
      if(error?.code === 400 && /capture method/i.test(error.msg)) return fail(`${JSON.stringify(captureMethod)} was refused as a capture method`);
    }
    pass('"Manual" and friends are read as manual and go on to the provider step');
  },
};
