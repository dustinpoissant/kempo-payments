# kempo-payments — PLAN: connected-account charges

> Status: **planned, nothing built.** This file scopes one change to an existing, published
> extension. It exists so [kempo-payouts](../kempo-payouts/PLAN.md) can be built on top.

> **Upstream changes are allowed.** Every dependency with `kempo` in its name (kempo, kempo-ui,
> kempo-css, kempo-server, kempo-payments, kempo-media, and the rest) is owned by the same person, and
> the goal of this project is to keep improving all of them. If the work here needs a change in one of
> them — a UI component, a payment call, a CMS hook — **make it, in that repository, without asking
> and without deferring it to a later step.** Do it the normal way there: tests, README and CHANGELOG,
> a backwards-compatible change where other packages depend on it, and the dependency order when
> publishing. Never commit a `file:` specifier.

## What changes and why

kempo-payments takes money into **the site's own Stripe account**. [kempo-payouts](../kempo-payouts/PLAN.md)
needs to take money **on a user's connected account** (Stripe Connect *direct charges*), with an
application fee for the site. The payment record, status vocabulary, refunds and webhooks should stay
in this one extension — payouts must not grow a second copy of payment state.

So this change makes kempo-payments able to create, read, refund and webhook-sync a payment that
lives on a connected account. **It adds capability; it changes nothing for a site that never uses it.**

## Not in scope

- Onboarding connected accounts, payouts, fee policy, recipient pages — all kempo-payouts.
- A second processor. The provider seam stays as it is.
- Destination charges. Direct charges only, deliberately: the recipient bears the processing fee,
  which is what makes a small percentage fee viable on tiny amounts.

## The change

1. **`createPayment` accepts** `connectedAccount` (`acct_…`) and `applicationFee` (minor units).
   Both optional. Both are stored on the payment row (new nullable columns).
2. **The provider contract grows** an options argument: `createIntent`, `retrieveIntent`, `capture`,
   `cancel`, `refund`, `listRefunds` receive `{ connectedAccount }`. In the Stripe module that is
   the `stripeAccount` request option, and `application_fee_amount` on create. **Every call that
   touches an intent for a connected-account payment must pass it** — an intent created on an
   account cannot be retrieved, captured or refunded without it, and the failure looks like "no
   such payment". Resolve it from the stored row, never from the caller.
3. **Refunds** accept `refundApplicationFee` (boolean, passed through to Stripe as
   `refund_application_fee`). Default: `true` for a payment that has an application fee.
4. **Client config** returns the connected account id for a given payment so the browser can
   initialise Stripe with it; `public/components/PaymentForm.js` takes a `connected-account`
   attribute (or reads it from the payment) and passes `{ stripeAccount }` when loading Stripe.
   Without this the Payment Element cannot confirm an intent that lives on another account.
5. **Webhooks.** Events for connected accounts arrive on a *Connect* endpoint with their own signing
   secret and carry an `account` field. kempo-payments must not own that endpoint; it must expose an
   entry point — `receiveVerifiedEvent(event)` in the SDK — that takes an event **already verified
   by the caller** and runs it through the same `interpretEvent` / `syncPayment` path. Document
   loudly that it does no signature check, and that only kempo-payouts should call it.
6. **Statuses and hooks are unchanged.** `payment:succeeded` and the rest fire as before, with the
   payment row now carrying `connectedAccount` and `applicationFee` so a listener can tell.

## Data

Add nullable `connectedAccount` and `applicationFee` columns to `kempoPayment`. This is a
**migration for already-installed sites**: it must go in `update.js` as an idempotent
`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, and a test must prove an update from the previous schema
works. kempo's declarative diff does not alter existing tables.

## Compatibility rule

A site on the current version that upgrades and never passes `connectedAccount` must behave
**byte-for-byte as before**. The existing test suite passing unchanged is the acceptance test for
that; do not edit existing tests to make them pass.

## Definition of done

- The five calls above work against a Stripe **test-mode** Connect account (document the manual
  procedure; the default test run never calls live Stripe).
- The migration is idempotent and tested.
- The old suite passes untouched. New tests cover: row stores the account and fee, refund of a
  connected payment passes the account, `receiveVerifiedEvent` updates a connected payment.
- README documents the new parameters, the `refundApplicationFee` default, and the webhook entry
  point's trust model. CHANGELOG written. It is a **minor** version — **committed locally; the owner
  publishes it** (2026-10-14: nothing is pushed by a build run).
- The unreleased commits already on this repository (`payment:failed` on every decline, the
  `payment:refunding` guard) ship in the same release, so the version this becomes carries them too:
  say so in the CHANGELOG.

## Conventions

Follow `~/dev/kempo/AGENTS.md` and this repo's own patterns. Never start/stop dev servers.
