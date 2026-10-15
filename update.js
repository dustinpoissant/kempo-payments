import install from './install.js';

/*
  Updating is the same job as installing: add the columns a newer version has, make sure the indexes
  exist, and say something useful if the encryption key is missing. Every statement is
  `IF NOT EXISTS`, so this is safe from any version to any other.

  The columns are the part that matters on an update. kempo's declarative diff adds new settings,
  permissions and groups before this runs, but it never alters an existing table — so a site that
  installed before `connectedAccount` and `applicationFee` gets them here or not at all.

  Existing values are never overwritten — a site's API keys, currency and capture method all
  survive an update untouched, and every existing payment reads back with both new columns null,
  which is what it was: a payment into the site's own account.
*/
export default async () => {
  await install();
};
