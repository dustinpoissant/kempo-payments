import {
  decimalsFor, formatAmount, fromMinor, isValidAmount, isValidCurrency, normaliseCurrency, toMinor,
} from '../server/utils/money/currencies.js';

/*
  Every case here is a way an amount could quietly become the wrong amount.

  These are not edge cases in the usual sense — a shop selling to Japan hits the zero-decimal path
  on every single order, and the failure mode is charging a hundred times too much or a hundredth
  as much. Neither throws, both look plausible on screen, and only the customer finds out.
*/

export default {
  'a two-decimal currency is the ordinary case': async ({ pass, fail }) => {
    if(decimalsFor('usd') !== 2) return fail('usd should have two decimal places');
    if(toMinor(12.99, 'usd') !== 1299) return fail(`12.99 usd became ${toMinor(12.99, 'usd')}`);
    if(fromMinor(1299, 'usd') !== 12.99) return fail('1299 usd should read back as 12.99');
    pass('dollars round-trip through minor units');
  },

  /*
    12.99 * 100 is 1298.9999999999998 in floating point. Truncating there charges $12.98 for a
    $12.99 item, forever, on a random-looking subset of prices.
  */
  'floating point does not lose a cent': async ({ pass, fail }) => {
    for(const [major, expected] of [[12.99, 1299], [0.29, 29], [1.15, 115], [70.55, 7055], [1.13, 113], [19.99, 1999]]){
      if(toMinor(major, 'usd') !== expected){
        return fail(`${major} became ${toMinor(major, 'usd')}, expected ${expected}`);
      }
    }
    pass('prices that are not representable in binary still convert exactly');
  },

  'a zero-decimal currency has no minor unit': async ({ pass, fail }) => {
    if(decimalsFor('jpy') !== 0) return fail('jpy should have no decimal places');
    if(toMinor(1200, 'jpy') !== 1200) return fail(`1200 jpy became ${toMinor(1200, 'jpy')} — a hundredfold error`);
    if(fromMinor(1200, 'jpy') !== 1200) return fail('1200 jpy should read back as 1200');
    if(!isValidAmount(1201, 'jpy')) return fail('any whole number of yen is chargeable');
    pass('yen are not divided by a hundred');
  },

  /*
    Three-decimal currencies are stored in thousandths but only chargeable in hundredths, so the
    last digit must be zero. A processor rejects the charge outright, which is a much better
    outcome than it silently rounding — but the refusal should happen here, where the amount was
    computed, not three layers away.
  */
  'a three-decimal currency must end in a zero': async ({ pass, fail }) => {
    if(decimalsFor('kwd') !== 3) return fail('kwd should have three decimal places');
    if(toMinor(1.5, 'kwd') !== 1500) return fail(`1.5 kwd became ${toMinor(1.5, 'kwd')}`);
    if(!isValidAmount(1500, 'kwd')) return fail('1500 is a valid kwd amount');
    if(isValidAmount(1505, 'kwd')) return fail('1505 is not chargeable in kwd — it is not a whole hundredth');
    pass('a dinar amount that cannot be charged is refused');
  },

  'an amount that is not a positive whole number is refused': async ({ pass, fail }) => {
    for(const amount of [0, -100, 12.99, NaN, Infinity, '1299', null, undefined]){
      if(isValidAmount(amount, 'usd')){
        return fail(`${JSON.stringify(amount)} was accepted as an amount`);
      }
    }
    pass('only positive integers are chargeable');
  },

  'currency codes are normalised and validated': async ({ pass, fail }) => {
    if(normaliseCurrency('  USD ') !== 'usd') return fail('a code should be trimmed and lowercased');
    if(!isValidCurrency('GBP')) return fail('GBP is a currency');
    for(const value of ['dollars', 'us', 'usdd', '', null, undefined, 'u$d']){
      if(isValidCurrency(value)) return fail(`${JSON.stringify(value)} was accepted as a currency`);
    }
    pass('anything that is not three letters is refused');
  },

  'formatting never throws on a currency the runtime does not know': async ({ pass, fail }) => {
    const formatted = formatAmount(1299, 'zzz');
    if(typeof formatted !== 'string' || !formatted.includes('ZZZ')){
      return fail(`an unknown currency produced ${JSON.stringify(formatted)}`);
    }
    pass('an unknown currency degrades to a number and a code');
  },
};
