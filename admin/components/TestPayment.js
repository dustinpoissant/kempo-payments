import LightComponent from '/kempo-ui/components/LightComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import '/payments/components/PaymentForm.js';
import { html } from '/kempo-ui/lit-all.min.js';
import { createPayment, getConfig, getPayment } from '/payments/sdk.js';
import { formatAmount, statusLabel, toMinor } from '/payments/utils/money.js';

/*
  Takes one real payment, through the real form, against the real processor.

  Worth a tab of its own because nothing else proves the connection works. Saved keys prove nothing
  — they prove somebody pasted a string. This exercises the whole path end to end: an intent
  created with the secret key, a form mounted with the publishable key, a confirmation from the
  browser, and then the part that actually matters — a webhook coming back and moving the payment
  to Paid. If the last step never happens, the payment sits at "Processing" on this screen, and
  that is the webhook endpoint telling you it is not configured.

  **Light DOM, and it has to be.** This component hosts `<k-pay-form>`, and Stripe's card fields do
  not mount inside a shadow root — they reserve the height and then render nothing, with no error
  anywhere (see PaymentForm.js's own note for what was actually measured). Everything else in this
  extension's admin is a ShadowComponent; this one cannot be, and neither can anything else that
  ends up containing the payment form.

  Styling therefore comes from kempo-css utilities rather than a `static styles` block, and the
  form's width from the 12-column grid.
*/
export default class TestPayment extends LightComponent {
  static properties = {
    config: { type: Object, state: true },
    amount: { type: String, state: true },
    description: { type: String, state: true },
    captureMethod: { type: String, state: true },
    payment: { type: Object, state: true },
    clientSecret: { type: String, state: true },
    outcome: { type: String, state: true },
    starting: { type: Boolean, state: true },
    error: { type: String, state: true },
  };

  #poll = null;

  constructor(){
    super();
    this.config = null;
    this.amount = '10.00';
    this.description = 'Test payment';
    this.captureMethod = '';
    this.payment = null;
    this.clientSecret = '';
    this.outcome = '';
    this.starting = false;
    this.error = '';
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    this.load();
  }

  disconnectedCallback(){
    super.disconnectedCallback();
    clearInterval(this.#poll);
  }

  load = async () => {
    const [error, config] = await getConfig();
    if(error){
      this.error = error.msg;
      return;
    }
    this.config = config;
    this.captureMethod = config.captureMethod || 'automatic';
  };

  /*
    Actions
  */

  start = async () => {
    const amount = toMinor(this.amount, this.config.currency);
    if(!amount || amount <= 0){
      this.error = 'Enter an amount to charge';
      return;
    }

    this.starting = true;
    this.error = '';
    this.outcome = '';

    const [error, result] = await createPayment({
      amount,
      currency: this.config.currency,
      description: this.description || 'Test payment',
      captureMethod: this.captureMethod,
      owner: 'kempo-payments',
      reference: 'admin-test',
    });

    this.starting = false;

    if(error){
      this.error = error.msg;
      return;
    }

    this.payment = result.payment;
    this.clientSecret = result.clientSecret;
  };

  /*
    The browser saying it worked is not the site knowing it worked — the webhook is. So after the
    form reports success, this re-reads the payment from the server until the status catches up,
    which is precisely the round trip being tested. It gives up after thirty seconds and says so,
    because "it never arrived" is the answer somebody needs, not a spinner forever.
  */
  confirmed = () => {
    this.outcome = 'waiting';
    const started = Date.now();

    clearInterval(this.#poll);
    this.#poll = setInterval(async () => {
      const [error, data] = await getPayment(this.payment.id);
      if(!error) this.payment = data.payment;

      if(data?.payment?.status === 'succeeded'){
        clearInterval(this.#poll);
        this.outcome = 'confirmed';
        return;
      }

      if(Date.now() - started > 30000){
        clearInterval(this.#poll);
        this.outcome = 'no-webhook';
      }
    }, 2000);
  };

  /*
    Deliberately no `payment-failed` handler. The form already shows the processor's message inside
    itself and goes back to accepting a card; repeating it here put the same red line on screen twice
    and, being set-and-never-cleared, left it there after a successful retry.
  */
  reset = () => {
    clearInterval(this.#poll);
    this.payment = null;
    this.clientSecret = '';
    this.outcome = '';
    this.error = '';
  };

  /*
    Rendering
  */

  #renderOutcome(){
    if(this.outcome === 'waiting'){
      return html`
        <p class="tc-muted"><k-spinner></k-spinner> Confirmed in the browser. Waiting for the processor’s webhook…</p>
      `;
    }

    if(this.outcome === 'confirmed'){
      return html`
        <div class="card tc-success">
          <strong><k-icon name="check_circle"></k-icon> Everything works.</strong>
          <p class="small">
            The payment was taken and the webhook came back and confirmed it. That is the whole path —
            any kempo (CMS) extension listening for <code class="ff-mono">payment:succeeded</code> would have fired just now.
          </p>
        </div>
      `;
    }

    if(this.outcome === 'no-webhook'){
      return html`
        <div class="card tc-warning">
          <strong>Paid, but nothing came back.</strong>
          <p class="small">
            The charge went through — it is ${statusLabel(this.payment.status).toLowerCase()} here, and the
            processor’s dashboard will show it. What did not happen is the webhook, so this site would never
            have learnt about it on its own, and no order would ever be fulfilled.
          </p>
          <p class="small mb0">
            Add the endpoint from the Settings tab, or forward events with
            <code class="ff-mono">stripe listen</code> if this site is running on localhost.
          </p>
        </div>
      `;
    }

    return '';
  }

  renderLightDom(){
    if(this.error && !this.config) return html`<p class="tc-danger">${this.error}</p>`;
    if(!this.config) return html`<k-spinner></k-spinner>`;

    if(!this.config.configured){
      return html`
        <p class="tc-muted">
          No processor is connected yet. Add its keys on the Settings tab and come back.
        </p>
      `;
    }

    if(this.payment){
      return html`
        <div class="row">
          <div class="span-6 t-span-9 m-span-12">
            ${this.config.mode === 'live' ? html`
              <div class="card tc-danger">
                <strong>These are live keys.</strong>
                <p class="small mb0">This will charge a real card. Switch to test keys unless that is what you meant.</p>
              </div>
            ` : html`
              <p class="small tc-muted">
                Test mode. Use card <code class="ff-mono">4242 4242 4242 4242</code>, any future expiry, any CVC.
                <code class="ff-mono">4000 0025 0000 3155</code> makes the bank ask for authentication;
                <code class="ff-mono">4000 0000 0000 9995</code> is declined.
              </p>
            `}

            <div class="card">
              <p><strong>${formatAmount(this.payment.amount, this.payment.currency)}</strong> — ${this.payment.description}</p>
              <k-pay-form
                client-secret=${this.clientSecret}
                submit-label="Pay ${formatAmount(this.payment.amount, this.payment.currency)}"
                @payment-succeeded=${this.confirmed}
                @payment-processing=${this.confirmed}
              ></k-pay-form>
            </div>

            ${this.#renderOutcome()}

            <button class="link" @click=${this.reset}>Start another</button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="row">
        <div class="span-5 t-span-7 m-span-12">
          <p class="tc-muted">
            Takes a payment the same way a checkout would, so the keys, the form and the webhook are all
            exercised at once. In test mode nothing real moves.
          </p>

          ${this.error ? html`<p class="tc-danger">${this.error}</p>` : ''}

          <label class="mb">
            <span class="d-b">Amount (${this.config.currency.toUpperCase()})</span>
            <input type="number" step="any" min="0" .value=${this.amount} @input=${event => { this.amount = event.target.value; }} />
          </label>

          <label class="mb">
            <span class="d-b">Description</span>
            <input type="text" .value=${this.description} @input=${event => { this.description = event.target.value; }} />
          </label>

          <label class="mb">
            <span class="d-b">Capture</span>
            <select .value=${this.captureMethod} @change=${event => { this.captureMethod = event.target.value; }}>
              <option value="automatic" ?selected=${this.captureMethod === 'automatic'}>Automatic — charge immediately</option>
              <option value="manual" ?selected=${this.captureMethod === 'manual'}>Manual — authorise only, capture later</option>
            </select>
          </label>

          <button class="primary" ?disabled=${this.starting} @click=${this.start}>
            ${this.starting ? 'Starting…' : 'Start payment'}
          </button>
        </div>
      </div>
    `;
  }
}

customElements.define('k-pay-test', TestPayment);
