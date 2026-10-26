import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import '/kempo-ui/components/Table.js';
import '/kempo-ui/components/controls/TcFirstPage.js';
import '/kempo-ui/components/controls/TcPrevPage.js';
import '/kempo-ui/components/controls/TcNextPage.js';
import '/kempo-ui/components/controls/TcLastPage.js';
import '/kempo-ui/components/controls/TcPageSelect.js';
import '/kempo-ui/components/controls/TcPageSize.js';
import '/admin/extension/kempo-payments/components/PaymentDetail.js';
import { html, css } from '/kempo-ui/lit-all.min.js';
import { listPayments, getSummary } from '/payments/sdk.js';
import { formatAmount, statusLabel, statusTone } from '/payments/utils/money.js';

/*
  Every payment the site has taken, and one of them at a time in detail.

  The list and the detail are the same component rather than two screens because the only reason to
  open a payment is something that just happened to it — a refund to issue, an authorisation to
  capture — and coming back to a list that has not noticed is how somebody refunds the same payment
  twice. Selecting is local state, so going back is instant and the filters are exactly as they
  were left. Clicking a row opens its payment.
*/

const FILTERS = [
  { value: '', label: 'All payments' },
  { value: 'succeeded', label: 'Paid' },
  { value: 'requires_capture', label: 'Awaiting capture' },
  { value: 'requires_payment_method,requires_confirmation,requires_action,processing', label: 'In progress' },
  { value: 'canceled,failed', label: 'Cancelled and failed' },
];

const PAGE_SIZE = 25;

const fields = [
  {
    name: 'amount', label: 'Amount', size: 220, editable: false,
    calculator: payment => `${formatAmount(payment.amount, payment.currency)}${payment.amountRefunded ? ` (−${formatAmount(payment.amountRefunded, payment.currency)} refunded)` : ''}`,
  },
  {
    name: 'status', label: 'Status', size: 220, editable: false,
    calculator: payment => `${statusLabel(payment.status)}${payment.disputed ? ' · Disputed' : ''}${payment.livemode ? '' : ' · Test'}`,
  },
  { name: 'description', label: 'For', editable: false, calculator: payment => payment.description || payment.reference || '—' },
  { name: 'createdAt', label: 'Started', size: 190, editable: false, formatter: value => new Date(value).toLocaleString() },
];

export default class PaymentList extends ShadowComponent {
  static properties = {
    total: { type: Number, state: true },
    filter: { type: String, state: true },
    summary: { type: Object, state: true },
    selected: { type: String, state: true },
    loading: { type: Boolean, state: true },
    error: { type: String, state: true },
  };

  constructor(){
    super();
    this.total = 0;
    this.filter = '';
    this.summary = null;
    this.selected = new URLSearchParams(location.search).get('payment') ?? '';
    this.loading = true;
    this.error = '';
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
const pane = this.closest('k-tab-content');
    // Loads when its tab is first opened, so a tab nobody opens makes no requests.
    if(!pane || pane.active) this.load();
    else this.closest('k-tabs')?.addEventListener('tabfirstshown', ({ detail }) => {
      if(detail.tab === pane.name) this.load();
    });
  }

  /*
    Data
  */

  /* The filter as the API takes it. */
  query = () => ({ status: this.filter || undefined });

  load = async () => {
    await this.updateComplete;
    const $table = this.renderRoot.querySelector('k-table');
    this.loading = true;
    this.error = '';

    const [error, data] = await listPayments({ ...this.query(), limit: PAGE_SIZE, offset: 0 });

    this.loading = false;

    if(error){
      this.error = error.msg;
      return;
    }

    this.total = data.total;
    $table?.setData({ records: data.payments, fields });
    $table?.setupFetchRecords(data.total, async (start, count) => {
      const [fetchError, page] = await listPayments({ ...this.query(), limit: count, offset: start });
      return fetchError ? [] : page.payments;
    });

    const [, summary] = await getSummary();
    this.summary = summary || null;
  };

  /*
    A refund or a capture changes both the row and the totals above it, so the whole screen reloads
    rather than the one row being patched — there is one payment on screen at that moment and the
    request is cheap.
  */
  refresh = () => this.load();

  changeFilter = event => {
    this.filter = event.target.value;
    this.load();
  };

  /* A click anywhere on a row opens that payment. */
  rowClicked = event => {
    const row = event.composedPath().find(node => node.classList?.contains?.('record'));
    const payment = row ? event.currentTarget.records[row.dataset.index] : null;
    if(payment) this.selected = payment.id;
  };

  back = () => {
    this.selected = '';
    this.load();
  };

  /*
    Rendering
  */

  #renderSummary(){
    if(!this.summary?.byStatus?.length) return '';

    /*
      Totals are per currency. Adding them together would be arithmetic on things that are not the
      same unit, and the number it produced would look entirely plausible.
    */
    const totals = new Map();
    for(const row of this.summary.byStatus){
      if(row.status !== 'succeeded') continue;
      const current = totals.get(row.currency) || { captured: 0, refunded: 0, count: 0 };
      totals.set(row.currency, {
        captured: current.captured + row.captured,
        refunded: current.refunded + row.refunded,
        count: current.count + row.count,
      });
    }

    const awaiting = this.summary.byStatus
      .filter(row => row.status === 'requires_capture')
      .reduce((sum, row) => sum + row.count, 0);

    return html`
      <div class="tiles d-f">
        ${[...totals.entries()].map(([currency, total]) => html`
          <div class="tile card">
            <span class="small tc-muted">Taken in ${currency.toUpperCase()}</span>
            <span class="value">${formatAmount(total.captured - total.refunded, currency)}</span>
            <span class="small tc-muted">
              ${total.count} payment${total.count === 1 ? '' : 's'}${total.refunded ? html` · ${formatAmount(total.refunded, currency)} refunded` : ''}
            </span>
          </div>
        `)}

        ${awaiting ? html`
          <div class="tile card">
            <span class="small tc-muted">Awaiting capture</span>
            <span class="value tc-warning">${awaiting}</span>
            <span class="small tc-muted">Holds that expire if nobody captures them</span>
          </div>
        ` : ''}

        ${this.summary.disputed ? html`
          <div class="tile card">
            <span class="small tc-muted">Disputed</span>
            <span class="value tc-danger">${this.summary.disputed}</span>
            <span class="small tc-muted">Answer these in the processor’s dashboard</span>
          </div>
        ` : ''}
      </div>
    `;
  }

  render(){
    if(this.selected){
      return html`
        <button class="link mb" @click=${this.back}>
          <k-icon name="arrow" direction="left"></k-icon> All payments
        </button>
        <k-pay-detail payment-id=${this.selected} @changed=${this.refresh}></k-pay-detail>
      `;
    }

    return html`
      ${this.#renderSummary()}

      <div class="controls d-f">
        <select .value=${this.filter} @change=${this.changeFilter}>
          ${FILTERS.map(option => html`<option value=${option.value} ?selected=${option.value === this.filter}>${option.label}</option>`)}
        </select>
        <button class="secondary" @click=${this.load}><k-icon name="replay"></k-icon> Refresh</button>
        ${this.loading ? html`<k-spinner></k-spinner>` : ''}
      </div>

      ${this.error ? html`<p class="tc-danger">${this.error}</p>` : ''}

      <k-table enable-pages page-size="25" page-size-options="[10,25,50]" placeholder=${this.filter ? 'No payments match that filter.' : 'No payments yet. Take one from the “Take a payment” tab to check the connection end to end.'} @click=${this.rowClicked}>
        <div class="d-f full" style="align-items: center;">
          <div>
            <kc-tc-first-page></kc-tc-first-page>
            <kc-tc-prev-page></kc-tc-prev-page>
            <kc-tc-next-page></kc-tc-next-page>
            <kc-tc-last-page></kc-tc-last-page>
          </div>
          <div class="flex"></div>
          <div><kc-tc-page-select></kc-tc-page-select></div>
          <div class="flex"></div>
          <div><kc-tc-page-size></kc-tc-page-size></div>
        </div>
      </k-table>
    `;
  }

  static styles = css`
    :host { display: block; }
    .tiles > .tile { margin-right: var(--spacer); min-width: 12rem; }
    .tile { display: flex; flex-direction: column; }
    .tile .value { font-size: 1.6rem; line-height: 1.2; font-weight: 600; }
    .controls { align-items: center; margin-bottom: var(--spacer); }
    .controls > * { margin-right: var(--spacer_h); }
    .controls select { margin-bottom: 0; max-width: 18rem; }
    k-table { cursor: pointer; }
  `;
}

customElements.define('k-pay-list', PaymentList);
