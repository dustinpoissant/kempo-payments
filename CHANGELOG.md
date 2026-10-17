# Changelog

All notable changes to `kempo-payments` are documented in this file.

## [Unreleased]

### Added

- **A Disputes page** (**Admin → Payments → Disputes**): the processor's chargebacks, open ones first with the soonest deadline at the top, each with its status, amount, the customer's reason in plain words, the sale it was about, and a button to answer it in Stripe. Read live from the processor, read-only (evidence is sent from the dashboard), behind `payments:view`. New `GET /payments/api/disputes`, `listDisputes` in the browser SDK, and `listDisputes` / `disputeUrl` on the provider contract.
- A payment can be opened from a link: `/admin/extension/kempo-payments/?payment=<id>`.
- **`<k-pay-form deferred>`**, for a checkout that puts the card on the same page as everything else. The card fields mount with no payment yet, `form.complete` says whether the number, expiry and CVC are valid, and `form.confirm({ clientSecret })` charges the card once the page has made the payment, resolving with `{ error, paymentIntent }` and firing the usual events. A deferred form has no button, no Express Checkout and no ZIP box of its own, and renders a `<div>` rather than a `<form>` so a page's own form can hold it. `card-change` fires as the card becomes complete. A form with a `client-secret` is unchanged. Needs a release that carries this (a minor) before kempo-commerce can ask for it.

### Changed

- **The Disputes menu icon ships with it** (`admin/icons/gavel.svg`), used by `icon-src`, instead of coming from kempo's shared set. The card glyph stays a name: the dashboard widget, which only takes icon names, uses it.
- Its menu entry is in the new **Payments** group, first (priority 79), instead of Commerce.

To be released as **0.2.0** (a minor), and carrying everything below in this section: the
connected-account support and the two earlier unreleased changes (`payment:refunding`, and
`payment:failed` on every decline). Committed locally; not pushed or published.

### Added — payments on a connected account (Stripe Connect direct charges)

What [kempo-payouts](https://github.com/dustinpoissant/kempo-payouts) builds on: a payment taken on a
user's own Stripe account, with a fee for the site. Nothing changes for a site that never uses it —
the existing suite passes unmodified.

- **`createPayment` takes `connectedAccount` (`acct_…`) and `applicationFee`** (minor units), both
  optional and both stored on the payment row as new nullable columns. A fee without an account, an
  account id that is not one, and a fee that is negative, not whole, or not less than the payment are
  refused with a 400 before the processor is contacted.
- **The provider contract takes the account on every call** — `createIntent`, `retrieveIntent`,
  `capture`, `cancel`, `refund`, `listRefunds` receive `{ connectedAccount }`, and the Stripe module
  sends it as the `Stripe-Account` header (and `application_fee_amount` on create). It is always read
  from the stored payment, never a caller. `clientConfig({ connectedAccount })` and `getClientSecret`
  return the account for the browser.
- **Refunds take an optional `idempotencyKey`**, sent to the processor with the refund, so a caller that
  retries after a timeout gets the refund it already made rather than a second one. Any payment, not
  only a connected one.
- **Refunds take `refundApplicationFee`**, default `true` for a payment that took a fee: the site's fee
  is given back in proportion. `false` keeps it. The admin refund form has a checkbox for it and the
  refund route accepts it.
- **`<k-pay-form connected-account="acct_…">`** initialises Stripe.js with `{ stripeAccount }`, without
  which it cannot confirm an intent on another account.
- **`receiveVerifiedEvent({ event })`** in the SDK applies a webhook event the caller has already
  verified — for kempo-payouts, which owns the separate Connect webhook endpoint. **It does no
  signature check**; only kempo-payouts should call it.
- **Events are applied only to payments on the account they came from**, on both entry points: a
  connected account's event to its own payment, the platform's to the platform's. Anything else is
  recorded and left alone.
- **`listPayments({ connectedAccount })`**, and the admin payment screen shows the account and fee.
- **Migration:** `update.js` (and `install.js`) add `connectedAccount` and `applicationFee` to an
  existing `kempoPayment` table with `ADD COLUMN IF NOT EXISTS`, since kempo never alters an existing
  table. Tested from a table without them.
- **`scripts/connect-test-mode.js`**, the manual procedure against Stripe's test mode: create with a
  fee, confirm, sync, fee received, refund with and without the fee, capture, cancel, client secret,
  a refund retried with the same key made once, and a real event through `receiveVerifiedEvent`. 14 of
  14 on 2026-10-15. `npm test` still never calls Stripe.

### Added

- **A `payment:refunding` guard hook.** Fired in bail mode before a refund reaches the processor, with
  `{ payment, amount, reason, issuedBy }`; a handler that throws `{ code, msg }` refuses the refund
  with that error and nothing is sent to the processor. The extension that took a payment can now
  refuse a refund it cannot honour — kempo-credits uses it so a payment for credits that have since
  been spent cannot be refunded from the Payments screen. Refunds made in the processor's own
  dashboard do not pass through it.

### Fixed

- **`payment:failed` fires for every decline, not just the first.** Stripe leaves a declined intent
  awaiting a card either way, so a second decline with the same message ("Your card was declined.")
  changed nothing on the payment row and fired nothing. That is exactly what card testing looks like,
  and a listener counting declines — kempo-credits' cool-down — heard one. Each new decline event now
  fires the hook; a redelivered event still does not, since it is dropped by event id first.

### Added

- **Dashboard widget.** A **Payments** widget on the kempo admin dashboard showing money captured and refunded per currency, the payment count and any disputes, with a **View payments** button, declared in `widgets` in `kempo-config.json`. Needs a kempo with the dashboard; ignored on older versions.
First release. Payment processing for kempo, with Stripe built in and a provider seam from the
first commit rather than the day a second processor is wanted.

- **A provider abstraction, before there is a second provider.** Everything outside
  `server/providers/` speaks one vocabulary — `createIntent`, `capture`, `refund`, `verifyEvent`,
  `interpretEvent`, and one set of statuses. Nothing else in the extension imports Stripe or knows
  it exists. The alternative was every call site growing a direct dependency on one company's SDK,
  which turns "add PayPal" into a change to the whole extension. PayPal, Square, Mollie and Amazon
  Pay are documented as the intended targets; Braintree and Adyen were considered and excluded.
- **Wallets and BNPL are not providers.** `automatic_payment_methods` on every intent means Apple
  Pay, Google Pay, Klarna, Afterpay and Affirm appear for the customers who qualify with no extra
  integration and no separate merchant account. Giving each its own provider module would duplicate
  an integration Stripe has already done.
- **No dependency on anything.** Taking a payment does not require a product catalog, so
  `kempo-commerce` depends on this and not the reverse — which is also what makes it usable by a
  subscription or donation extension that has no catalog at all.
- **Amounts are integers in the currency's minor unit, and floats are refused.** A caller passing
  `49.99` meant $49.99 and would be charging five cents, and the processor would accept that
  instruction without complaint. Zero-decimal currencies (yen) and three-decimal ones (dinars) are
  handled rather than assumed away — the assumption is a hundredfold error on every order to Japan.
- **The webhook is the authority on whether a payment succeeded, not the browser.** A customer whose
  connection drops the instant after their card is charged tells the site nothing, and one who wants
  to can make their browser claim anything. `payment:succeeded` fires from the verified webhook, on
  the transition into that state and nowhere else, so it fires exactly once per payment however many
  times an event is redelivered.
- **Webhook deduplication hangs off a primary key, not an index.** kempo's installer creates columns
  and primary keys from a Drizzle schema and nothing else — a `unique()` or a unique index is not
  carried across. So `kempoPaymentEvent`'s primary key *is* `provider:eventId`, which cannot quietly
  stop working on a site whose indexes were never made. The indexes the extension does want are
  created by hand in `install.js`, and a test checks that list against the schema.
- **The refunded total is recomputed from refund rows, never incremented.** An admin issuing a
  refund and the webhook reporting the same refund are two accounts of one event; incrementing on
  both is a payment claiming twice the money went back. Refunds are keyed by the processor's own
  reference, so they deduplicate — including refunds made directly in the processor's dashboard,
  which arrive by webhook and are recorded here with nobody attributed.
- **Refunding and cancelling are kept distinct.** An authorisation that was never captured has had
  nothing taken from it; releasing it is a cancel. Asking to refund one is refused with that
  sentence rather than the processor's `payment_intent_unexpected_state`.
- **Credentials use kempo's `secret` setting type**, encrypted at rest and never returned to a
  browser — the settings route reports whether a credential is *set*, as a boolean, rather than
  masking a value into a response and hoping nothing logs it. A secret key pasted into the
  publishable-key field is refused outright, because that field is served to every visitor.
- **Test and live mode are read off the key prefixes**, not a separate toggle. A toggle can disagree
  with the keys, and mismatched keys — a test secret with a live publishable — surface in the
  browser as a generic error with nothing pointing at the cause, so that combination is detected and
  named on the settings screen.
- **A "Take a payment" tab in the admin**, which exists because saved keys prove only that somebody
  pasted a string. It runs the whole path end to end and then waits for the webhook, so a site whose
  endpoint is not configured finds out there rather than in production with paid, unfulfilled orders.
- `<k-pay-form>`, a reusable payment form served from the extension, split into two independent
  pieces rather than Stripe's all-in-one Payment Element — card number/expiry/CVC as three small
  fields this extension lays out and labels itself, and an Express Checkout button row (Apple Pay,
  Google Pay, Link, and Klarna/Cash App Pay/Amazon Pay wherever the merchant has activated them)
  that Stripe draws and drives entirely. The difference is what each one is: tapping a wallet button
  opens the *native OS payment sheet*, not an iframe, and tapping Klarna hands the customer to
  Klarna's own redirect for the credit check nothing here can shortcut — neither is Stripe's or this
  extension's to restyle. A card field is genuinely Stripe's iframe, because collecting a card
  number in a plain kempo-ui `<input>` means taking on PCI compliance the extension is built
  specifically to avoid. Confirmed through two different Stripe.js calls that happen to share one
  `elements` group — `confirmCardPayment` for the card fields, `confirmPayment` for whichever wallet
  the customer picked — because the server side of this extension does not care which produced the
  confirmation.
- **And it cannot live inside a shadow root.** Measured while building this: in the light DOM a
  Stripe field brings up a real iframe; inside a shadow root, a stub with nothing in it, no error
  raised anywhere. So the form renders light DOM, and the admin's own test screen is the one
  LightComponent among this extension's components. The README says so where a checkout author will
  read it, because the symptom — an empty rectangle where a card field should be — points at nothing.
- **The card fields' box is real CSS on the wrapper `<div>`, not anything Stripe paints.** The first
  version of this tried `appearance.rules['.Input']`, which does restyle Stripe's newer elements —
  and does nothing at all for `cardNumber`/`cardExpiry`/`cardCvc` specifically, silently: their
  iframe renders transparent and unpadded by design, a caller-draws-the-box contract predating the
  `appearance` API. Found by setting a background directly on the wrapper and watching a field
  become visible for the first time. `.k-pay-field`, injected once into `document.head` since a
  LightComponent has no shadow root to scope a `static styles` block into, is kempo-css's own
  `input` rule copied onto a class — the one part of this component's styling that needed no
  cross-iframe resolution at all, being plain same-document CSS.
- **The fields' *text* colour needed two separate fixes stacked, and the first one alone shipped
  briefly looking fixed while still being wrong.** First: kempo-css declares its text colours with
  an alpha channel — `rgba(255, 255, 255, 0.93)` — and Stripe's colour variables reject that
  outright: `stripe.elements(): invalid variable value "rgba(255, 255, 255, 0.93)" provided to
  "colorText"`. Not a theory — Stripe's own console warning, caught live. Painting the value onto a
  real canvas pixel and reading the bytes back fixed *that* — the only step that reliably forces an
  alpha-blended, possibly-oklch source colour down to the plain opaque `rgb()` the warning asked
  for. The warning went away and the fields rendered *something*, close enough at a glance to read
  as fixed. It was not: hardcoding `colorText` to an unmistakable red next proved
  `appearance.variables` doesn't reach `cardNumber`/`cardExpiry`/`cardCvc` **at all**, opaque colour
  or not — the same silent no-op as the `.Input` rules above, one layer deeper, with no warning
  this time because the value itself was valid. The real fix is the `style` option every version of
  these elements has always taken — `style.base.color`, `style.base['::placeholder']` — verified by
  typing real digits and sampling actual pixel bytes from the screenshot afterward
  (`rgb(240, 240, 240)` text on `rgb(41, 41, 41)` field, not an impression of "looks about right").
- **An event log on every payment.** It is the answer to the only hard question a payment screen
  gets — the customer says they paid and this says they did not — and the answer is usually a
  webhook that never arrived, which an empty log shows at a glance.

### Fixed before release

Each of these was found by testing against a real Stripe account and a real database, not by
reading the code. Each has a test that fails without the fix, with one exception: fetching a
payment's refunds from Stripe needs a live account, so that path has a test for the event shape
and was verified by hand against Stripe's test mode.

- **A refund made outside this extension was recorded as nothing.** On the current Stripe API
  version `charge.refunded` reports only the new running total; the event has no `refunds` list.
  The translation read the missing list as "no refunds", marked the event handled, and left the
  payment showing $0.00 refunded while the customer had been paid back. The extension now asks
  Stripe for the payment's refunds when the event does not name them, and **Check with Stripe**
  reconciles from the same source. The old test fixture used the *old* event shape, which is why
  nothing had caught it.
- **A webhook that failed to apply was lost for good.** The event was marked handled before it was
  applied, so when applying failed the endpoint returned an error, Stripe retried, and the retry
  was answered "duplicate" and dropped. Handled now means applied; a failed apply releases its
  claim so the retry does the work.
- **A mistyped capture method charged the card.** Every spelling of `manual` except the exact
  lowercase one — `Manual`, `MANUAL `, `hold`, a typo — fell back to `automatic`, so a caller who
  meant to reserve a card took the money. Now case and spaces are forgiven, anything else is a 400
  before any processor is contacted, and the settings screen applies the same rule.
- **A NUL byte in caller text made Stripe act and then Postgres refuse.** For a payment that meant
  an intent created and cancelled again; for a refund it meant a refund that had happened, a 500,
  and a retry that would repeat it. Caller-supplied text (description, reference, metadata, refund
  reason, list filters) is checked up front and refused with a 400. Text from the processor is
  stripped instead of refused, since the money has already moved.
- **Raw processor errors reached callers.** A non-card Stripe error — a misconfigured key, say —
  came back as roughly 1,500 characters including a dashboard link. Card errors, which are written
  for the customer, pass through whole; everything else is cut to its first sentence and capped,
  with the full text logged on the server.
- **The over-refund message quoted a raw number** (`Only 500 is left`) on a screen that shows
  `$5.00` everywhere else. It now uses the payment's own currency formatting, including yen.
- **The test suites could empty a real site's payments.** The database suites purge the payment
  tables, and were run once against the demo site's database. They now refuse to run unless the
  database name ends in `_test`.

[Unreleased]: https://github.com/dustinpoissant/kempo-payments
