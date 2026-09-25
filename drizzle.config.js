import { defineConfig } from 'drizzle-kit';

/*
  Local/CI test-database setup only — this extension has no migrations of its own in production.
  Its tables are created the real way, via createTablesFromSchema at install time, which the
  data-layer suite exercises directly. This file exists so `npx drizzle-kit push` can stand up a
  throwaway database holding kempo's core tables and this extension's own.

  No dotenv here on purpose: nothing in this repo's own runtime loads .env either. DATABASE_URL
  needs to be a real environment variable — export it, or prefix the command.
*/
export default defineConfig({
  schema: [
    './server/db/schema.js',
    './node_modules/kempo/server/db/schema.js',
  ],
  out: './server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
