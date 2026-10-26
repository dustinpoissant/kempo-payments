import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import '/kempo-ui/components/Table.js';
import './DisputeInStripe.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import { listDisputes } from '/payments/sdk.js';
import { formatAmount } from '/payments/utils/money.js';

/*
  The disputes (chargebacks) the processor has open or has closed, with the soonest deadline first.

  Read-only on purpose. A dispute is answered in the processor's own dashboard, where the evidence
  form, the file uploads and the deadline emails already live and where evidence can only be sent
  once; this page is for knowing a dispute exists, how long is left and which sale it was, and for
  getting to the right dispute in one click. A row opens the payment on this site, and the Stripe
  button opens the dispute itself.
*/

const FILTERS = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

const STATUS = {
  needs_response: { label: 'Needs a response' },
  under_review: { label: 'Under review by the bank' },
  won: { label: 'Won' },
  lost: { label: 'Lost' },
  closed: { label: 'Closed' },
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
  if(left <= 0) return 'Overdue';
  const hours = Math.floor(left / 3600000);
  if(hours < 24) return `In ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `In ${days} day${days === 1 ? '' : 's'}`;
};

const PAYMENT = '/admin/extension/kempo-payments/';

const fields = [
  { name: 'dueBy', label: 'Due', size: 150, editable: false, calculator: dispute => dispute.open && dispute.dueBy ? `${timeLeft(dispute.dueBy)} · ${new Date(dispute.dueBy).toLocaleDateString()}` : '—' },
  {
    name: 'status', label: 'Status', size: 240, editable: false,
    calculator: dispute => `${(STATUS[dispute.status] ?? STATUS.closed).label}${dispute.inquiry ? ' · An inquiry: not yet a chargeback' : ''}${dispute.open && dispute.hasEvidence ? ' · Evidence sent' : ''}${dispute.livemode ? '' : ' · Test'}`,
  },
  { name: 'amount', label: 'Amount', size: 120, editable: false, calculator: dispute => formatAmount(dispute.amount, dispute.currency) },
  { name: 'reason', label: 'Why', editable: false, calculator: dispute => reasonText(dispute.reason) },
  { name: 'sale', label: 'Sale', size: 240, editable: false, calculator: dispute => dispute.payment ? (dispute.payment.description || dispute.payment.reference || 'The payment') : 'A payment this site did not record' },
  { name: 'created', label: 'Opened', size: 120, editable: false, formatter: value => new Date(value).toLocaleDateString() },
];

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

  /* Refills the table whenever the disputes change. A row with a payment on this site opens it. */
  updated(changed){
    if(!changed.has('items')) return;
    this.renderRoot.querySelector('k-table')?.setData({
      records: this.items.map(dispute => ({ ...dispute, _url: dispute.payment ? `${PAYMENT}?payment=${encodeURIComponent(dispute.payment.id)}` : undefined })),
      fields,
    });
  }

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
        <k-table open-on-click placeholder="No disputes to show.">
          <k-pay-dispute-stripe slot="after"></k-pay-dispute-stripe>
        </k-table>
      ` : nothing}
    `;
  }
}

customElements.define('k-pay-disputes', DisputeList);
