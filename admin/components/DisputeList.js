import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import { listDisputes } from '/payments/sdk.js';
import { formatAmount } from '/payments/utils/money.js';

/*
  The disputes (chargebacks) the processor has open or has closed, with the soonest deadline first.

  Read-only on purpose. A dispute is answered in the processor's own dashboard, where the evidence
  form, the file uploads and the deadline emails already live and where evidence can only be sent
  once; this page is for knowing a dispute exists, how long is left and which sale it was, and for
  getting to the right dispute in one click.
*/

const FILTERS = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

const STATUS = {
  needs_response: { label: 'Needs a response', tone: 'danger' },
  under_review: { label: 'Under review by the bank', tone: 'warning' },
  won: { label: 'Won', tone: 'success' },
  lost: { label: 'Lost', tone: 'danger' },
  closed: { label: 'Closed', tone: 'muted' },
};

/* What the bank's reason code means, in a sentence a shop owner can act on. */
const REASONS = {
  fraudulent: 'The customer says they did not make the purchase',
  unrecognized: 'The customer does not recognise the charge',
  product_not_received: 'The customer says it never arrived',
  product_unacceptable: 'The customer says it was not as described',
  duplicate: 'The customer says they were charged twice',
  credit_not_processed: 'The customer says a refund never came',
  subscription_canceled: 'The customer says they cancelled a subscription',
  general: 'The customer disputed the charge',
  customer_initiated: 'The customer disputed the charge',
  debit_not_authorized: 'The customer says the debit was not authorised',
  incorrect_account_details: 'The account details were incorrect',
  insufficient_funds: 'The customer\'s account had insufficient funds',
  bank_cannot_process: 'The bank could not process the charge',
  check_returned: 'The check was returned',
};

const reasonText = reason => REASONS[reason] ?? (reason ? reason.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase()) : 'No reason given');

/* How long is left, as words: "in 3 days", "in 5 hours", "overdue". */
const timeLeft = dueBy => {
  const left = new Date(dueBy).getTime() - Date.now();
  if(left <= 0) return { text: 'Overdue', tone: 'danger' };
  const hours = Math.floor(left / 3600000);
  if(hours < 24) return { text: `In ${hours} hour${hours === 1 ? '' : 's'}`, tone: 'danger' };
  const days = Math.floor(hours / 24);
  return { text: `In ${days} day${days === 1 ? '' : 's'}`, tone: days <= 3 ? 'danger' : days <= 7 ? 'warning' : 'muted' };
};

export default class DisputeList extends ShadowComponent {
  static properties = {
    items: { type: Array, state: true },
    openCount: { type: Number, state: true },
    filter: { type: String, state: true },
    loading: { type: Boolean, state: true },
    error: { type: String, state: true },
  };

  constructor(){
    super();
    this.items = [];
    this.openCount = 0;
    this.filter = 'open';
    this.loading = true;
    this.error = '';
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
    this.loading = true;
    this.error = '';
    const [error, data] = await listDisputes({ status: this.filter });
    this.loading = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.items = data.items;
    this.openCount = data.openCount;
  };

  /*
    Event handlers
  */

  changeFilter = event => {
    this.filter = event.target.value;
    this.load();
  };

  /*
    Rendering
  */

  renderRow(dispute){
    const status = STATUS[dispute.status] ?? STATUS.closed;
    const left = dispute.open && dispute.dueBy ? timeLeft(dispute.dueBy) : null;
    return html`
      <tr>
        <td>
          ${left ? html`<strong class="tc-${left.tone}">${left.text}</strong><span class="small tc-muted d-b">${new Date(dispute.dueBy).toLocaleDateString()}</span>` : html`<span class="tc-muted">—</span>`}
        </td>
        <td>
          <span class="tc-${status.tone}">${status.label}</span>
          ${dispute.inquiry ? html`<span class="small tc-muted d-b">An inquiry: not yet a chargeback</span>` : nothing}
          ${dispute.open && dispute.hasEvidence ? html`<span class="small tc-muted d-b">Evidence sent</span>` : nothing}
          ${dispute.livemode ? nothing : html`<span class="small tc-muted d-b">Test</span>`}
        </td>
        <td>${formatAmount(dispute.amount, dispute.currency)}</td>
        <td class="small">${reasonText(dispute.reason)}</td>
        <td class="small">
          ${dispute.payment
            ? html`<a href=${`/admin/extension/kempo-payments/?payment=${encodeURIComponent(dispute.payment.id)}`}>${dispute.payment.description || dispute.payment.reference || 'The payment'}</a>`
            : html`<span class="tc-muted">A payment this site did not record</span>`}
        </td>
        <td class="small tc-muted">${new Date(dispute.created).toLocaleDateString()}</td>
        <td>
          ${dispute.dashboardUrl ? html`<a class="btn ta-center" href=${dispute.dashboardUrl} target="_blank" rel="noopener">${dispute.open ? 'Answer in Stripe' : 'View in Stripe'} <k-icon name="open_in_new"></k-icon></a>` : nothing}
        </td>
      </tr>
    `;
  }

  render(){
    return html`
      <div class="d-f mb" style="align-items: center; gap: var(--spacer_h);">
        <select .value=${this.filter} @change=${this.changeFilter} style="max-width: 12rem;">
          ${FILTERS.map(option => html`<option value=${option.value} ?selected=${option.value === this.filter}>${option.label}</option>`)}
        </select>
        <button class="secondary" @click=${this.load}><k-icon name="replay"></k-icon> Refresh</button>
        ${this.loading ? html`<k-spinner></k-spinner>` : nothing}
      </div>

      ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
      ${this.openCount ? html`<p class="tc-danger"><strong>${this.openCount}</strong> ${this.openCount === 1 ? 'dispute needs' : 'disputes need'} attention. Answer before the due date or the bank rules against you.</p>` : nothing}

      ${!this.loading && !this.error && !this.items.length ? html`<p class="tc-muted">${this.filter === 'open' ? 'No open disputes.' : 'No disputes to show.'}</p>` : nothing}

      ${this.items.length ? html`
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Due</th><th>Status</th><th>Amount</th><th>Why</th><th>Sale</th><th>Opened</th><th></th></tr></thead>
            <tbody>${this.items.map(dispute => this.renderRow(dispute))}</tbody>
          </table>
        </div>
      ` : nothing}
    `;
  }
}

customElements.define('k-pay-disputes', DisputeList);
