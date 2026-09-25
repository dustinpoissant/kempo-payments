import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { html, css } from '/kempo-ui/lit-all.min.js';
import { getSettings, saveSettings } from '/payments/sdk.js';

/*
  Connecting the site to a processor.

  Three things on this screen are load-bearing and none of them is the form itself:

  - **The mode banner.** Test keys and live keys look identical at a glance and behave identically
    until real money is involved. Which one is in use is stated in words, at the top, always.
  - **The webhook endpoint.** Copy-pasteable, with the exact list of events beside it. A site whose
    endpoint is wrong takes payments perfectly and never learns that any of them succeeded, and the
    symptom appears nowhere near the cause.
  - **Blank means unchanged.** A secret cannot be read back, so its field is always empty. Saving
    the form after changing the currency must not wipe the keys, and clearing one on purpose is a
    separate, explicit button.
*/
export default class ProviderSettings extends ShadowComponent {
  static properties = {
    settings: { type: Object, state: true },
    providers: { type: Array, state: true },
    status: { type: Object, state: true },
    encryptionConfigured: { type: Boolean, state: true },
    values: { type: Object, state: true },
    edits: { type: Object, state: true },
    saving: { type: Boolean, state: true },
    error: { type: String, state: true },
    notice: { type: String, state: true },
  };

  constructor(){
    super();
    this.settings = null;
    this.providers = [];
    this.status = null;
    this.encryptionConfigured = true;
    this.values = {};
    /*
      Credential fields are kept apart from the rest. They are the only ones whose current value
      cannot be read back, so "what is in the box" and "what is stored" are different questions for
      them and the same question for everything else.
    */
    this.edits = {};
    this.saving = false;
    this.error = '';
    this.notice = '';
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    this.load();
  }

  /*
    Data
  */

  load = async () => {
    const [error, data] = await getSettings();
    if(error){
      this.error = error.msg;
      return;
    }

    this.settings = data.settings;
    this.providers = data.providers;
    this.status = data.status;
    this.encryptionConfigured = data.encryptionConfigured;
    this.values = { ...data.settings };
    this.edits = {};
  };

  get provider(){
    return this.providers.find(entry => entry.name === this.values.provider) || this.providers[0] || null;
  }

  set = (name, value) => {
    this.values = { ...this.values, [name]: value };
  };

  edit = (name, value) => {
    this.edits = { ...this.edits, [name]: value };
  };

  save = async () => {
    this.saving = true;
    this.error = '';
    this.notice = '';

    /*
      Only what was actually typed. An untouched credential field is not sent at all, which is what
      makes "blank means unchanged" true at the wire rather than only in the route.
    */
    const body = {
      provider: this.values.provider,
      currency: this.values.currency,
      capture_method: this.values.captureMethod,
    };

    for(const field of this.provider?.credentialFields || []){
      const value = this.edits[field.name];
      if(value === null || (typeof value === 'string' && value.trim())) body[field.name] = value;
    }

    const [error] = await saveSettings(body);
    this.saving = false;

    if(error){
      this.error = error.msg;
      return;
    }

    // Typed keys are dropped the moment they are stored — there is no reason for one to sit in a
    // form field on an admin's screen for the rest of the afternoon.
    this.edits = {};
    this.notice = 'Saved.';
    await this.load();
  };

  clear = async name => {
    this.edits = { ...this.edits, [name]: null };
    await this.save();
  };

  copyWebhookUrl = () => {
    navigator.clipboard?.writeText(this.webhookUrl);
    this.notice = 'Endpoint URL copied.';
  };

  get webhookUrl(){
    return `${window.location.origin}${this.provider?.webhookPath || ''}`;
  }

  /*
    Rendering
  */

  #renderBanner(){
    if(!this.encryptionConfigured){
      return html`
        <div class="card banner tc-danger">
          <strong>SETTINGS_ENCRYPTION_KEY is not set on this server.</strong>
          <p class="small">
            API credentials are encrypted with it, so none can be stored until it exists. Generate one with
            <code class="ff-mono">node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"</code>,
            put it in the site’s environment, and restart. Back it up — losing it makes every stored secret unrecoverable.
          </p>
        </div>
      `;
    }

    if(!this.status?.configured){
      return html`
        <div class="card banner tc-warning">
          <strong>Not connected.</strong>
          <p class="small">Nothing can be charged until a publishable key and a secret key are saved below.</p>
        </div>
      `;
    }

    if(this.status.mismatchedKeys){
      return html`
        <div class="card banner tc-danger">
          <strong>These keys are from different modes.</strong>
          <p class="small">
            The secret key is a ${this.status.mode} key and the publishable key is not. A payment started
            with one cannot be completed with the other, and the failure shows up in the customer’s browser
            as a generic error. Use both keys from the same place.
          </p>
        </div>
      `;
    }

    if(!this.status.hasWebhookSecret){
      return html`
        <div class="card banner tc-warning">
          <strong>No webhook signing secret.</strong>
          <p class="small">
            Payments will be taken and none of them will ever be confirmed here — every incoming event is
            rejected without it. Add the endpoint below, then paste its signing secret in.
          </p>
        </div>
      `;
    }

    return html`
      <div class="card banner ${this.status.livemode ? 'tc-danger' : 'tc-success'}">
        <strong>
          ${this.status.livemode
            ? 'Connected in live mode — payments taken here are real.'
            : 'Connected in test mode. No real money can move.'}
        </strong>
      </div>
    `;
  }

  #renderCredentials(){
    const provider = this.provider;
    if(!provider) return '';

    return provider.credentialFields.map(field => {
      const isSet = !!this.status?.fields?.[field.name];
      const value = this.edits[field.name];

      return html`
        <label class="field">
          <span class="d-b">${field.label} ${isSet ? html`<span class="small tc-success">· set</span>` : ''}</span>
          <span class="small tc-muted d-b">${field.help}</span>
          <input
            type=${field.type === 'secret' ? 'password' : 'text'}
            autocomplete="off"
            placeholder=${isSet ? '•••••••• — leave blank to keep' : field.placeholder}
            .value=${typeof value === 'string' ? value : ''}
            @input=${event => this.edit(field.name, event.target.value)}
          />
          ${isSet ? html`
            <button class="link small" ?disabled=${this.saving} @click=${() => this.clear(field.name)}>Clear this key</button>
          ` : ''}
        </label>
      `;
    });
  }

  render(){
    if(!this.settings) return html`<k-spinner></k-spinner>`;

    const provider = this.provider;

    return html`
      ${this.#renderBanner()}
      ${this.error ? html`<p class="tc-danger">${this.error}</p>` : ''}
      ${this.notice ? html`<p class="tc-success small">${this.notice}</p>` : ''}

      <h2>Processor</h2>
      <label class="field">
        <span class="small tc-muted d-b">Where payments are taken</span>
        <select .value=${this.values.provider} @change=${event => this.set('provider', event.target.value)}>
          ${this.providers.map(entry => html`
            <option value=${entry.name} ?selected=${entry.name === this.values.provider}>${entry.label}</option>
          `)}
        </select>
      </label>

      ${this.#renderCredentials()}

      <h2>Webhook endpoint</h2>
      <p class="small tc-muted">
        Add this in the processor’s dashboard. It is how this site finds out a payment succeeded —
        the customer’s browser is never trusted for that, because it may be closed, offline, or lying.
      </p>
      <div class="endpoint d-f">
        <input class="ff-mono" type="text" readonly .value=${this.webhookUrl} />
        <button class="secondary" @click=${this.copyWebhookUrl}><k-icon name="content_copy"></k-icon> Copy</button>
      </div>
      ${provider?.webhookEvents?.length ? html`
        <p class="small tc-muted">Subscribe it to these events:</p>
        <ul class="events small ff-mono">
          ${provider.webhookEvents.map(event => html`<li>${event}</li>`)}
        </ul>
      ` : ''}
      <p class="small tc-muted">
        On a machine the processor cannot reach — localhost — forward them instead:
        <code class="ff-mono">stripe listen --forward-to ${this.webhookUrl}</code>.
        That prints its own signing secret, which is the one to paste above while developing.
      </p>

      <h2>Defaults</h2>
      <label class="field">
        <span class="d-b">Currency</span>
        <span class="small tc-muted d-b">Used when whatever is asking for a payment does not name one</span>
        <input type="text" maxlength="3" .value=${this.values.currency} @input=${event => this.set('currency', event.target.value)} />
      </label>

      <label class="field">
        <span class="d-b">Capture</span>
        <span class="small tc-muted d-b">
          Automatic charges the card when the customer confirms. Manual only places a hold, and somebody
          has to capture it before it expires — right for anything that ships, wrong for anything instant.
        </span>
        <select .value=${this.values.captureMethod} @change=${event => this.set('captureMethod', event.target.value)}>
          <option value="automatic" ?selected=${this.values.captureMethod === 'automatic'}>Automatic</option>
          <option value="manual" ?selected=${this.values.captureMethod === 'manual'}>Manual</option>
        </select>
      </label>

      <button class="primary" ?disabled=${this.saving} @click=${this.save}>
        ${this.saving ? 'Saving…' : 'Save settings'}
      </button>
    `;
  }

  static styles = css`
    :host { display: block; }
    .banner { margin-bottom: var(--spacer); }
    .banner p { margin-bottom: 0; }
    .field { margin-bottom: var(--spacer); max-width: 40rem; }
    .endpoint { align-items: center; margin-bottom: var(--spacer_h); }
    .endpoint input { margin-bottom: 0; margin-right: var(--spacer_h); flex: 1 1 20rem; }
    .events { margin-left: var(--spacer); }
  `;
}

customElements.define('k-pay-settings', ProviderSettings);
