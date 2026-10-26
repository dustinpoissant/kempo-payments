import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import '/kempo-ui/components/Table.js';
import '/kempo/components/Permission.js';
import { html, css } from '/kempo-ui/lit-all.min.js';
import {
  getPayment, capturePayment, cancelPayment, refundPayment, syncPayment,
} from '/payments/sdk.js';
import { formatAmount, fromMinor, statusLabel, statusTone, toMinor } from '/payments/utils/money.js';

/*
  One payment, and everything anybody can do to it.

  The event log is on the screen rather than behind a link because it is the answer to the question
  this screen exists to settle: the customer says they paid and this says they did not. Nine times
  out of ten the log is empty, which means no webhook ever arrived, which means the endpoint or its
  signing secret is wrong — and that is visible at a glance rather than after an hour of guessing.
*/
const refundFields = [
  { name: 'amount', label: 'Amount', size: 140, editable: false, calculator: refund => formatAmount(refund.amount, refund.currency) },
  { name: 'status', label: 'Status', size: 130, editable: false },
  { name: 'reason', label: 'Reason', editable: false, calculator: refund => refund.reason || '—' },
  { name: 'createdAt', label: 'When', size: 200, editable: false, formatter: value => new Date(value).toLocaleString() },
];

const eventFields = [
  { name: 'type', label: 'Event', size: 300, editable: false },
  { name: 'createdAt', label: 'Received', size: 200, editable: false, formatter: value => new Date(value).toLocaleString() },
  { name: 'handled', label: '', size: 180, editable: false, calculator: event => event.error || (event.handledAt ? 'Handled' : 'Queued') },
];


export default class PaymentDetail extends ShadowComponent {
  static properties = {
    paymentId: { type: String, attribute: 'payment-id' },
    payment: { type: Object, state: true },
    refunds: { type: Array, state: true },
    events: { type: Array, state: true },
    refundable: { type: Number, state: true },
    refundAmount: { type: String, state: true },
    refundReason: { type: String, state: true },
    refundFee: { type: Boolean, state: true },
    busy: { type: String, state: true },
    error: { type: String, state: true },
    notice: { type: String, state: true },
  };

  constructor(){
    super();
    this.paymentId = '';
    this.payment = null;
    this.refunds = [];
    this.events = [];
    this.refundable = 0;
    this.refundAmount = '';
    this.refundReason = '';
    this.refundFee = true;
    this.busy = '';
    this.error = '';
    this.notice = '';
  }

  /*
    Lifecycle
  */

  updated(changed){
    super.updated?.(changed);
    if(changed.has('paymentId') && this.paymentId) this.load();
    if(changed.has('refunds')) this.renderRoot.querySelector('#refundsTable')?.setData({ records: this.refunds, fields: refundFields });
    if(changed.has('events')) this.renderRoot.querySelector('#eventsTable')?.setData({ records: this.events, fields: eventFields });
  }

  /*
    Data
  */

  load = async () => {
    this.error = '';
    const [error, data] = await getPayment(this.paymentId);
    if(error){
      this.error = error.msg;
      return;
    }

    this.payment = data.payment;
    this.refunds = data.refunds;
    this.events = data.events;
    this.refundable = data.refundable;
    // Prefilled with everything outstanding, which is what a refund usually is.
    this.refundAmount = data.refundable ? String(fromMinor(data.refundable, data.payment.currency)) : '';
  };

  /*
    Actions
  */

  #run = async (name, action) => {
    this.busy = name;
    this.error = '';
    this.notice = '';

    const [error] = await action();

    this.busy = '';
    if(error){
      this.error = error.msg;
      return false;
    }

    await this.load();
    // The list behind this panel shows the status and the refunded total, both of which just moved.
    this.dispatchEvent(new CustomEvent('changed', { bubbles: true, composed: true }));
    return true;
  };

  capture = () => this.#run('capture', () => capturePayment(this.payment.id));

  cancel = () => this.#run('cancel', () => cancelPayment(this.payment.id));

  sync = async () => {
    const before = this.payment.status;
    const ok = await this.#run('sync', () => syncPayment(this.payment.id));
    if(ok){
      this.notice = this.payment.status === before
        ? 'The processor agrees with what is shown here — nothing changed.'
        : `Updated from the processor: now ${statusLabel(this.payment.status).toLowerCase()}.`;
    }
  };

  refund = async () => {
    const amount = toMinor(this.refundAmount, this.payment.currency);
    if(!amount || amount <= 0){
      this.error = 'Enter an amount to refund';
      return;
    }

    const ok = await this.#run('refund', () => refundPayment(this.payment.id, { amount, reason: this.refundReason || null, ...(this.payment.applicationFee > 0 ? { refundApplicationFee: this.refundFee } : {}) }));
    if(ok){
      this.refundReason = '';
      this.notice = 'Refund issued. It can take a few days to appear on the customer’s statement.';
    }
  };

  /*
    Rendering
  */

  #renderActions(){
    const payment = this.payment;

    return html`
      <div class="actions d-f">
        ${payment.status === 'requires_capture' ? html`
          <k-permission has="payments:capture">
            <button class="success" ?disabled=${!!this.busy} @click=${this.capture}>
              Capture ${formatAmount(payment.amount, payment.currency)}
            </button>
          </k-permission>
        ` : ''}

        ${['succeeded', 'canceled', 'failed'].includes(payment.status) ? '' : html`
          <k-permission has="payments:capture">
            <button ?disabled=${!!this.busy} @click=${this.cancel}>Cancel</button>
          </k-permission>
        `}

        <k-permission has="payments:view">
          <button class="secondary" ?disabled=${!!this.busy} @click=${this.sync}>
            <k-icon name="replay"></k-icon> Check with ${payment.provider}
          </button>
        </k-permission>

        ${this.busy ? html`<k-spinner></k-spinner>` : ''}
      </div>
    `;
  }

  #renderRefund(){
    const payment = this.payment;
    if(!this.refundable) return '';

    return html`
      <k-permission has="payments:refund">
        <div class="card refund">
          <h3>Refund</h3>
          <p class="small tc-muted">
            ${formatAmount(this.refundable, payment.currency)} of
            ${formatAmount(payment.amountCaptured, payment.currency)} is still refundable.
          </p>

          <label>
            <span class="small tc-muted">Amount (${payment.currency.toUpperCase()})</span>
            <input
              type="number"
              step="any"
              min="0"
              max=${fromMinor(this.refundable, payment.currency)}
              .value=${this.refundAmount}
              @input=${event => { this.refundAmount = event.target.value; }}
            />
          </label>

          <label>
            <span class="small tc-muted">Reason (kept on the record here; shown to nobody outside)</span>
            <input
              type="text"
              placeholder="requested_by_customer, duplicate, fraudulent, or anything you like"
              .value=${this.refundReason}
              @input=${event => { this.refundReason = event.target.value; }}
            />
          </label>

          ${payment.applicationFee > 0 ? html`
            <label class="checkbox mb">
              <input type="checkbox" .checked=${this.refundFee} @change=${event => { this.refundFee = event.target.checked; }} />
              Give back the site’s fee too
              <small class="d-b tc-muted">This payment went to a connected account and the site kept ${formatAmount(payment.applicationFee, payment.currency)}. Ticked, that fee is returned in proportion to the refund; unticked, the account pays the whole refund and the site keeps its fee.</small>
            </label>
          ` : ''}

          <button class="danger" ?disabled=${!!this.busy} @click=${this.refund}>Refund</button>
        </div>
      </k-permission>
    `;
  }

  #renderEvents(){
    if(!this.events.length){
      return html`
        <p class="small tc-muted">
          Nothing has been heard from the processor about this payment.
          ${this.payment.status === 'succeeded' ? '' : html`
            That is expected for a payment nobody has completed yet — but if the customer says they
            paid, it means the webhook endpoint is not reaching this site. Check it on the Settings tab.
          `}
        </p>
      `;
    }

    return html`
      <k-table id="eventsTable"></k-table>
    `;
  }

  render(){
    if(this.error && !this.payment) return html`<p class="tc-danger">${this.error}</p>`;
    if(!this.payment) return html`<k-spinner></k-spinner>`;

    const payment = this.payment;

    return html`
      <div class="head d-f">
        <div>
          <span class="amount">${formatAmount(payment.amount, payment.currency)}</span>
          <span class="badge tc-${statusTone(payment.status)}">${statusLabel(payment.status)}</span>
          ${payment.disputed ? html`<span class="badge tc-danger"><k-icon name="warning"></k-icon> Disputed</span>` : ''}
          ${payment.livemode ? '' : html`<span class="badge tc-muted">Test</span>`}
        </div>
      </div>

      ${payment.description ? html`<p>${payment.description}</p>` : ''}
      ${payment.lastError ? html`<p class="tc-danger small">${payment.lastError}</p>` : ''}
      ${this.error ? html`<p class="tc-danger small">${this.error}</p>` : ''}
      ${this.notice ? html`<p class="tc-muted small">${this.notice}</p>` : ''}

      ${this.#renderActions()}

      <dl class="facts">
        <dt>Processor</dt><dd>${payment.provider}</dd>
        <dt>Reference</dt><dd class="ff-mono small">${payment.providerRef}</dd>
        <dt>Captured</dt><dd>${formatAmount(payment.amountCaptured, payment.currency)}</dd>
        <dt>Refunded</dt><dd>${formatAmount(payment.amountRefunded, payment.currency)}</dd>
        <dt>Capture</dt><dd>${payment.captureMethod === 'manual' ? 'Manual — must be captured' : 'Automatic'}</dd>
        ${payment.connectedAccount ? html`
          <dt>Paid to</dt><dd><span class="ff-mono">${payment.connectedAccount}</span> — a connected account, not this site’s</dd>
          <dt>Site’s fee</dt><dd>${formatAmount(payment.applicationFee || 0, payment.currency)}</dd>
        ` : ''}
        ${payment.owner ? html`<dt>Requested by</dt><dd>${payment.owner}${payment.reference ? ` · ${payment.reference}` : ''}</dd>` : ''}
        ${payment.customerEmail ? html`<dt>Email</dt><dd>${payment.customerEmail}</dd>` : ''}
        <dt>Started</dt><dd>${new Date(payment.createdAt).toLocaleString()}</dd>
      </dl>

      ${this.#renderRefund()}

      ${this.refunds.length ? html`
        <h3>Refunds</h3>
        <k-table id="refundsTable"></k-table>
      ` : ''}

      <h3>What the processor has told us</h3>
      ${this.#renderEvents()}
    `;
  }

  static styles = css`
    :host { display: block; }
    .head { align-items: baseline; justify-content: space-between; }
    .amount { font-size: 1.6rem; font-weight: 600; margin-right: var(--spacer_h); }
    .badge { font-size: var(--fs_small); margin-right: var(--spacer_h); white-space: nowrap; }
    .actions { align-items: center; }
    .actions > * { margin-right: var(--spacer_h); margin-bottom: var(--spacer_h); }
    .facts { display: grid; grid-template-columns: max-content 1fr; column-gap: var(--spacer); row-gap: var(--spacer_q); margin: var(--spacer) 0; }
    .facts dt { color: var(--tc_muted); font-size: var(--fs_small); }
    .facts dd { margin: 0; }
    .refund label { margin-bottom: var(--spacer_h); }
    .refund input { max-width: 24rem; }
  `;
}

customElements.define('k-pay-detail', PaymentDetail);
