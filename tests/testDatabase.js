import { sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';

/*
  Whether a suite may use the database it can see.

  data-layer and lifecycle empty the payment tables before they run, and lifecycle drops indexes.
  That is only acceptable on a throwaway database, so a database whose name does not end in `_test`
  is treated as not there at all — the suites skip themselves — rather than being trusted because
  it happens to be reachable. Pointing a run at the demo site's database wiped its payments once;
  this is what stops that being possible. Every kempo repo's test database follows the same
  naming (`kempo_payments_test`, see docker-compose.yml).
*/

const name = (() => {
  try{
    return new URL(process.env.DATABASE_URL).pathname.slice(1);
  }catch{
    return '';
  }
})();

export const isTestDatabase = name.endsWith('_test');

export const databaseReachable = isTestDatabase && await db.execute(sql`select 1`).then(() => true).catch(() => false);

export const skipReason = isTestDatabase
  ? 'no database reachable'
  : `the database ${name ? `"${name}"` : 'in DATABASE_URL'} is not named *_test, so these suites will not empty its tables`;
