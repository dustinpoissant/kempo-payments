import LightComponent from '/kempo-ui/components/LightComponent.js';
import '/kempo-ui/components/Spinner.js';
import { html } from '/kempo-ui/lit-all.min.js';
import { getConfig } from '/payments/sdk.js';

/*
  The payment form a customer actually types into, served at /payments/components/PaymentForm.js.

  ```html
  <script type="module" src="/payments/components/PaymentForm.js"></script>
  <k-pay-form client-secret="pi_3..._secret_..." return-url="https://example.com/thanks"></k-pay-form>
  ```

  Card details never touch this server. The number/expiry/CVC fields are three small iframes
  belonging to the processor, and confirming sends them from the customer's browser straight to
  it — which is what keeps a kempo site out of PCI scope, and is not an implementation detail
  anybody should optimise away. There is no way to collect a card number in a plain kempo-ui
  `<input>` without taking on that scope yourself; this is as close to "our own component" as a
  card field gets. See CONTRIBUTING.md's note on this if the question comes up again.

  Two kinds of field, deliberately not Stripe's all-in-one "Payment Element":

  - **Card fields** (`cardNumber` / `cardExpiry` / `cardCvc`) are three separate split fields
    rather than one combined widget, so this markup owns the labels and layout and only the digits
    themselves live in Stripe's iframe. Confirmed with `stripe.confirmCardPayment()`, the API this
    split-field shape has always used; it takes the card element directly rather than going through
    an `elements` group.

    These are the *legacy* Stripe elements, and neither half of the modern `appearance` API reaches
    them — confirmed by testing both, not assumed. Their iframe is **transparent and unpadded by
    design**: setting a background directly on the wrapper `<div>` made a field visible for the
    first time; `appearance.rules['.Input']` changes nothing. So `.k-pay-field`, injected once by
    this module, *is* the input box — kempo-css's own real `input` rule, copied property-for-
    property onto a class, because there is no such utility class already and no other way to make
    a wrapper around a cross-origin iframe look like a kempo-css input. See `injectFieldStyles`.

    The *text* colour has the same problem a layer deeper: `appearance.variables.colorText` also
    does not reach these elements — proved by hardcoding it to an unmistakable red and watching
    nothing change. These three element types predate the `appearance` API entirely and have always
    taken their own `style` option instead (`style.base.color`, `style.base['::placeholder']`) —
    that is the one mechanism confirmed, by testing with real typed digits and pixel-sampling the
    result, to actually work. See `buildFieldStyle`.
  - **Express Checkout** (Apple Pay / Google Pay / Link, and PayPal, Klarna, Cash App Pay or Amazon
    Pay if activated in the Stripe dashboard) is a single button row Stripe draws and manages
    entirely — tapping a wallet button opens the *native* OS payment sheet, not an iframe, which is
    why it is not reskinned here; tapping Klarna or a similar method hands the customer to that
    provider's own redirect for a credit check nothing here can shortcut, same as it always did
    through Stripe's unified Payment Element. Hidden automatically when nothing is available;
    confirmed with `stripe.confirmPayment()`. This is a newer, unified element type, and unlike the
    split card fields above, it *does* take its styling from `appearance` normally.

  **This element must not be placed inside a shadow root**, and it renders into the light DOM
  itself for the same reason. Stripe's card fields do not mount inside one: they reserve the height
  and then render nothing at all, with no error, in the browser or anywhere else. Measured while
  building the previous version of this component — in the light DOM a Stripe field brings up a
  real iframe; inside a shadow root, a stub with nothing in it.

  So a page or component hosting `<k-pay-form>` has to be light DOM all the way up. That is why
  this extension's own test screen is the one LightComponent among its admin components, and it is
  the first thing to check if a checkout somewhere shows an empty box where a card field should be.

  What it emits, and nothing it emits should be trusted as proof of payment:

  | Event                | When                                                       |
  |----------------------|------------------------------------------------------------|
  | `payment-succeeded`  | the processor confirmed it in this browser                  |
  | `payment-processing` | accepted, still settling — common for bank debits           |
  | `payment-failed`     | declined, or the customer's details were rejected           |

  Use them to move the customer along — a thank-you page, a spinner. Do *not* use them to fulfil an
  order. A browser closed at the wrong moment never fires anything, and one under someone's control
  can fire whatever it likes. The `payment:succeeded` server hook is what fulfilment hangs off.
*/

let stripeJs = null;

const loadStripeJs = () => {
  if(window.Stripe) return Promise.resolve(window.Stripe);

  if(!stripeJs){
    stripeJs = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.async = true;
      script.onload = () => resolve(window.Stripe);
      /*
        Loaded from the processor rather than bundled, and it has to be: Stripe requires it so the
        fraud signals and 3-D Secure handling can be updated without every site that takes payments
        having to redeploy. A self-hosted copy is not supported and stops working.
      */
      script.onerror = () => reject(new Error('The payment library could not be loaded'));
      document.head.appendChild(script);
    });
  }

  return stripeJs;
};

/*
  The box every card field sits in — real CSS, in this document, because it never has to cross
  into Stripe's iframe: kempo-css's own rule for a real `<input>` (background, border, radius,
  padding, and the same focus ring, standing in for `:focus` with `:focus-within` since focus
  itself lives one document down, inside the iframe), copied onto a class name instead of an
  element selector. Injected once into `document.head` — a light DOM component has no shadow root
  to scope a `static styles` block into, and this only needs to exist globally once regardless of
  how many `<k-pay-form>` elements are on the page.
*/
let fieldStylesInjected = false;

const injectFieldStyles = () => {
  if(fieldStylesInjected) return;
  fieldStylesInjected = true;

  const style = document.createElement('style');
  style.textContent = `
    .k-pay-field {
      display: block;
      width: 100%;
      background-color: var(--input_bg);
      border: var(--input_border_width) solid var(--c_input_border);
      border-radius: var(--radius);
      padding: var(--input_padding);
      transition: box-shadow var(--animation_ms);
    }
    .k-pay-field:focus-within {
      box-shadow: var(--focus_shadow);
    }
  `;
  document.head.appendChild(style);
};

/*
  What Stripe *does* draw for a split card field is the text — the digits themselves, and their
  placeholder — and that still has to cross into the iframe as an `appearance` value, with the same
  two problems as anything else that crosses that boundary:

  - kempo-css declares its text colours with `light-dark(…)`, and the *declared* value of a custom
    property is that function's literal text — reading one off `document.documentElement` hands
    Stripe a string it cannot parse, not a colour. A throwaway element that actually *uses* the
    token in a real CSS property forces the browser to resolve it into the value it would paint
    with, which is why every colour below goes through a probe rather than a direct property read.
  - `--tc` and `--tc_muted` carry an alpha channel — `rgba(255, 255, 255, 0.93)`, not a fully
    opaque colour — and Stripe's colour variables reject that outright: `stripe.elements(): invalid
    variable value "rgba(255, 255, 255, 0.93)" provided to "colorText"; "colorText" accepts a valid
    HEX, rgb(), or hsl() CSS color.` Not a theory — that is Stripe's own console warning, seen live
    once this was wired up. `compositeColor` is what fixes both problems in one step: it paints the
    value onto a real canvas pixel *over the background it will actually sit on* and reads the
    bytes back, which leaves a plain opaque `rgb(...)` regardless of what colour function or alpha
    the source value used — the same value the browser would have painted, with nothing left for
    Stripe's parser to reject.
*/
let compositeContext = null;

const compositeColor = (foreground, background) => {
  if(!compositeContext){
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    compositeContext = canvas.getContext('2d', { willReadFrequently: true });
  }
  compositeContext.fillStyle = background;
  compositeContext.fillRect(0, 0, 1, 1);
  compositeContext.fillStyle = foreground;
  compositeContext.fillRect(0, 0, 1, 1);
  const [r, g, b] = compositeContext.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
};

const readTokens = () => {
  // The background text will actually sit on is `--input_bg`, not the page's — needed as the
  // compositing base below, never sent to Stripe itself now that the field's own box is real CSS.
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;background-color:var(--input_bg);outline-color:var(--tc_muted);';
  document.body.appendChild(probe);
  const probeStyles = getComputedStyle(probe);
  const inputBackground = compositeColor(probeStyles.backgroundColor, 'black');
  const rawMutedText = probeStyles.outlineColor;
  probe.remove();

  const pageProbe = document.createElement('div');
  pageProbe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;background-color:var(--c_bg);color:var(--tc);';
  document.body.appendChild(pageProbe);
  const pageStyles = getComputedStyle(pageProbe);
  const pageBackground = compositeColor(pageStyles.backgroundColor, 'black');
  const text = compositeColor(pageStyles.color, inputBackground);
  const mutedText = compositeColor(rawMutedText, inputBackground);
  pageProbe.remove();

  // These, unlike the ones above, are plain opaque literals in kempo-css (a fixed rgb(), a fixed
  // rem) — no light-dark, no alpha, no nested var() — so reading them directly off the root is
  // already the resolved value. Still composited: nothing stops a future kempo-css release from
  // switching one of these to oklch or adding alpha, and the failure mode is exactly this quiet.
  const root = getComputedStyle(document.documentElement);
  const primary = root.getPropertyValue('--c_primary').trim();
  const danger = root.getPropertyValue('--c_danger').trim();

  return {
    pageBackground,
    text,
    mutedText,
    primary: primary ? compositeColor(primary, pageBackground) : undefined,
    danger: danger ? compositeColor(danger, pageBackground) : undefined,
    radius: root.getPropertyValue('--radius').trim() || undefined,
    fontFamily: getComputedStyle(document.body).fontFamily || undefined,
  };
};

// Perceived brightness, to pick which of the processor's two base themes to build on. A dark base
// with light overrides looks far better than a light one with the colours swapped out from under it.
const isDark = colour => {
  const [r = 255, g = 255, b = 255] = (String(colour).match(/[\d.]+/g) || []).map(Number);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
};

const buildAppearance = tokens => ({
  theme: isDark(tokens.pageBackground) ? 'night' : 'stripe',
  variables: {
    colorBackground: tokens.pageBackground,
    colorText: tokens.text,
    ...(tokens.mutedText ? { colorTextPlaceholder: tokens.mutedText } : {}),
    ...(tokens.primary ? { colorPrimary: tokens.primary } : {}),
    ...(tokens.danger ? { colorDanger: tokens.danger } : {}),
    ...(tokens.radius ? { borderRadius: tokens.radius } : {}),
    ...(tokens.fontFamily ? { fontFamily: tokens.fontFamily } : {}),
  },
});

/*
  The split card fields' *own* styling option — `appearance` (above) is confirmed, by testing, not
  to reach them at all: neither `variables.colorText` nor `rules['.Input']` change anything about
  what they render, silently, the same silent-no-effect failure twice over. `cardNumber` /
  `cardExpiry` / `cardCvc` predate the `appearance` API and have always taken their own `style`
  option instead — `base` for the normal state, `invalid` for one Stripe itself has flagged, each a
  CSS-in-JS-shaped object rather than the appearance API's flat variables. This is the one that
  actually paints the typed digits and the placeholder a colour anyone can read.
*/
const buildFieldStyle = tokens => ({
  base: {
    color: tokens.text,
    fontFamily: tokens.fontFamily || undefined,
    '::placeholder': { color: tokens.mutedText },
  },
  ...(tokens.danger ? { invalid: { color: tokens.danger, iconColor: tokens.danger } } : {}),
});

export default class PaymentForm extends LightComponent {
  static properties = {
    clientSecret: { type: String, attribute: 'client-secret' },
    publishableKey: { type: String, attribute: 'publishable-key' },
    returnUrl: { type: String, attribute: 'return-url' },
    submitLabel: { type: String, attribute: 'submit-label' },
    phase: { type: String, state: true },
    message: { type: String, state: true },
    fieldError: { type: String, state: true },
    expressAvailable: { type: Boolean, state: true },
    postalCode: { type: String, state: true },
  };

  #stripe = null;
  #elements = null;
  #mountedFor = null;
  #themeWatchers = [];
  #fields = {};
  #fieldErrors = { number: '', expiry: '', cvc: '' };

  constructor(){
    super();
    this.clientSecret = '';
    this.publishableKey = '';
    /*
      Payment methods that leave the site to authenticate — a bank's 3-D Secure page — have to be
      told where to come back to, and the processor refuses to start one without it. Defaulting to
      this page means that works without every caller remembering to set it, and a caller with a
      real thank-you page still overrides it.
    */
    this.returnUrl = window.location.href;
    this.submitLabel = 'Pay';
    this.phase = 'idle';
    this.message = '';
    this.fieldError = '';
    this.expressAvailable = false;
    this.postalCode = '';
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    injectFieldStyles();
    this.#watchTheme();
  }

  updated(){
    super.updated();
    this.#mount();
  }

  disconnectedCallback(){
    super.disconnectedCallback();
    for(const stop of this.#themeWatchers) stop();
    this.#themeWatchers = [];
    this.#elements = null;
    this.#fields = {};
    this.#mountedFor = null;
  }

  /*
    Restyles the fields in place when the page's theme changes. `elements.update` is the only way in
    — the fields are in the processor's iframes, and re-mounting to restyle would throw away
    whatever the customer had already typed. One call restyles every field mounted under this
    element's `elements` group, express checkout included, since they all share one group.

    Two sources, because kempo-css has two: an explicit `theme` attribute on <html>, and the system
    preference it falls back to when that says `auto`.
  */
  #watchTheme(){
    const restyle = () => {
      if(!this.#elements) return;
      const tokens = readTokens();
      this.#elements.update({ appearance: buildAppearance(tokens) });
      // `elements.update` only reaches the appearance-API elements (Express Checkout here) — the
      // three split fields need their own `style` re-applied individually, same as at mount time.
      const fieldStyle = buildFieldStyle(tokens);
      this.#fields.cardNumber?.update({ style: fieldStyle });
      this.#fields.cardExpiry?.update({ style: fieldStyle });
      this.#fields.cardCvc?.update({ style: fieldStyle });
    };

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', restyle);
    this.#themeWatchers.push(() => query.removeEventListener('change', restyle));

    const observer = new MutationObserver(restyle);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['theme'] });
    this.#themeWatchers.push(() => observer.disconnect());
  }

  /*
    Mounting
  */

  async #mount(){
    if(!this.clientSecret || this.#mountedFor === this.clientSecret) return;
    this.#mountedFor = this.clientSecret;

    const expressTarget = this.querySelector('[data-express-checkout]');
    const numberTarget = this.querySelector('[data-card-number]');
    const expiryTarget = this.querySelector('[data-card-expiry]');
    const cvcTarget = this.querySelector('[data-card-cvc]');
    if(!expressTarget || !numberTarget || !expiryTarget || !cvcTarget) return;

    this.phase = 'loading';
    this.message = '';

    try {
      let key = this.publishableKey;
      if(!key){
        const [error, config] = await getConfig();
        if(error) throw new Error(error.msg);
        if(!config.configured) throw new Error('No payment provider is connected to this site yet');
        key = config.publishableKey;
      }

      const Stripe = await loadStripeJs();
      this.#stripe = Stripe(key);
      const tokens = readTokens();
      const fieldStyle = buildFieldStyle(tokens);
      this.#elements = this.#stripe.elements({ clientSecret: this.clientSecret, appearance: buildAppearance(tokens) });

      const expressCheckout = this.#elements.create('expressCheckout');
      expressCheckout.mount(expressTarget);
      expressCheckout.on('ready', ({ availablePaymentMethods }) => {
        this.expressAvailable = !!availablePaymentMethods && Object.keys(availablePaymentMethods).length > 0;
      });
      // Fired by a click on whichever wallet button the customer chose. The element has already
      // collected everything it needs by this point — confirming is the whole handler.
      expressCheckout.on('confirm', async () => {
        const { error, paymentIntent } = await this.#stripe.confirmPayment({
          elements: this.#elements,
          confirmParams: { return_url: this.returnUrl },
          redirect: 'if_required',
        });
        this.#finish(error, paymentIntent);
      });
      this.#fields.expressCheckout = expressCheckout;

      const onFieldChange = (field, event) => {
        this.#fieldErrors[field] = event.error?.message || '';
        this.fieldError = Object.values(this.#fieldErrors).find(Boolean) || '';
      };

      const cardNumber = this.#elements.create('cardNumber', { showIcon: true, style: fieldStyle });
      cardNumber.mount(numberTarget);
      cardNumber.on('change', event => onFieldChange('number', event));
      this.#fields.cardNumber = cardNumber;

      const cardExpiry = this.#elements.create('cardExpiry', { style: fieldStyle });
      cardExpiry.mount(expiryTarget);
      cardExpiry.on('change', event => onFieldChange('expiry', event));
      this.#fields.cardExpiry = cardExpiry;

      // Not passed to confirmCardPayment directly — Stripe.js auto-links split card fields created
      // under the same `elements` group, so mounting is all cardExpiry/cardCvc are needed for.
      const cardCvc = this.#elements.create('cardCvc', { style: fieldStyle });
      cardCvc.mount(cvcTarget);
      cardCvc.on('change', event => onFieldChange('cvc', event));
      this.#fields.cardCvc = cardCvc;

      this.phase = 'ready';
    } catch(error) {
      // A remount is the only way out of a failed load, so let the next update try again.
      this.#mountedFor = null;
      this.phase = 'error';
      this.message = error.message;
    }
  }

  /*
    Confirming
  */

  submit = async event => {
    event?.preventDefault();
    if(this.phase !== 'ready') return;

    this.phase = 'submitting';
    this.message = '';

    const { error, paymentIntent } = await this.#stripe.confirmCardPayment(this.clientSecret, {
      payment_method: {
        card: this.#fields.cardNumber,
        ...(this.postalCode ? { billing_details: { address: { postal_code: this.postalCode } } } : {}),
      },
    });

    this.#finish(error, paymentIntent);
  };

  #finish(error, paymentIntent){
    if(error){
      this.phase = 'ready';
      this.message = error.message || 'The payment could not be completed';
      this.dispatchEvent(new CustomEvent('payment-failed', { detail: { message: this.message }, bubbles: true }));
      return;
    }

    if(paymentIntent?.status === 'processing'){
      this.phase = 'processing';
      this.message = 'Payment received — it is still being confirmed by the bank.';
      this.dispatchEvent(new CustomEvent('payment-processing', { detail: { paymentIntent }, bubbles: true }));
      return;
    }

    this.phase = 'done';
    this.message = '';
    this.dispatchEvent(new CustomEvent('payment-succeeded', { detail: { paymentIntent }, bubbles: true }));
  }

  /*
    Rendering
  */

  renderLightDom(){
    /*
      Every mount target below is rendered unconditionally, in every phase. Lit reuses a node only
      while the template shape around it holds still — put one behind a conditional and a re-render
      replaces it with a fresh one, tearing out whichever processor iframe was living there along
      with anything the customer had already typed into it. The express-checkout wrapper is toggled
      with the `hidden` attribute rather than removed for the same reason.
    */
    return html`
      <div class="mb" ?hidden=${!this.expressAvailable}>
        <div class="full" data-express-checkout></div>
        <p class="small tc-muted ta-center my">or pay with card</p>
      </div>

      <form @submit=${this.submit}>
        <label class="mb">
          <span class="small tc-muted d-b">Card number</span>
          <div class="k-pay-field" data-card-number></div>
        </label>

        <div class="row mb">
          <label class="col mrh">
            <span class="small tc-muted d-b">Expiry</span>
            <div class="k-pay-field" data-card-expiry></div>
          </label>
          <label class="col mrh">
            <span class="small tc-muted d-b">CVC</span>
            <div class="k-pay-field" data-card-cvc></div>
          </label>
          <label class="col">
            <span class="small tc-muted d-b">ZIP / postal</span>
            <input
              type="text"
              autocomplete="postal-code"
              .value=${this.postalCode}
              @input=${event => { this.postalCode = event.target.value; }}
            />
          </label>
        </div>

        ${this.fieldError ? html`<p class="tc-danger small">${this.fieldError}</p>` : ''}

        ${this.phase === 'loading' ? html`<p class="tc-muted small mt"><k-spinner></k-spinner> Loading the payment form…</p>` : ''}

        ${this.message ? html`
          <p class="${this.phase === 'processing' ? 'tc-muted' : 'tc-danger'} small">${this.message}</p>
        ` : ''}

        ${this.phase === 'done' ? html`<p class="tc-success">Payment complete.</p>` : html`
          <button type="submit" class="primary full mt" ?disabled=${this.phase !== 'ready'}>
            ${this.phase === 'submitting' ? 'Paying…' : this.submitLabel}
          </button>
        `}
      </form>
    `;
  }
}

customElements.define('k-pay-form', PaymentForm);
