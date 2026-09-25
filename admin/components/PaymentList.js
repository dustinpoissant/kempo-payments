import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
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
  were left.
*/

const FILTERS = [
  { value: '', label: 'All payments' },
  { value: 'succeeded', label: 'Paid' },
  { value: 'requires_capture', label: 'Awaiting capture' },
  { value: 'requires_payment_method,requires_confirmation,requires_action,processing', label: 'In progress' },
  { value: 'canceled,failed', label: 'Cancelled and failed' },
];

const PAGE_SIZE = 25;

export default class PaymentList extends ShadowComponent {
  static properties = {
    payments: { type: Array, state: true },
    total: { type: Number, state: true },
    offset: { type: Number, state: true },
    filter: { type: String, state: true },
    summary: { type: Object, state: true },
    selected: { type: String, state: true },
    loading: { type: Boolean, state: true },
    error: { type: String, state: true },
  };

  constructor(){
    super();
    this.payments = [];
    this.total = 0;
    this.offset = 0;
    this.filter = '';
    this.summary = null;
    this.selected = '';
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

    const [error, data] = await listPayments({
      status: this.filter || undefined,
      limit: PAGE_SIZE,
      offset: this.offset,
    });

    this.loading = false;

    if(error){
      this.error = error.msg;
      return;
    }

    this.payments = data.payments;
    this.total = data.total;

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
    this.offset = 0;
    this.load();
  };

  page = delta => {
    this.offset = Math.max(0, this.offset + delta * PAGE_SIZE);
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

  #renderTable(){
    if(this.loading && !this.payments.length) return html`<k-spinner></k-spinner>`;

    if(!this.payments.length){
      return html`
        <p class="tc-muted">
          ${this.filter ? 'No payments match that filter.' : 'No payments yet. Take one from the “Take a payment” tab to check the connection end to end.'}
        </p>
      `;
    }

    return html`
      <div class="table-wrapper">
        <table>
          <thead>
            <tr><th>Amount</th><th>Status</th><th>For</th><th>Started</th><th></th></tr>
          </thead>
          <tbody>
            ${this.payments.map(payment => html`
              <tr @click=${() => { this.selected = payment.id; }}>
                <td>
                  ${formatAmount(payment.amount, payment.currency)}
                  ${payment.amountRefunded ? html`<span class="small tc-muted d-b">−${formatAmount(payment.amountRefunded, payment.currency)} refunded</span>` : ''}
                </td>
                <td>
                  <span class="tc-${statusTone(payment.status)}">${statusLabel(payment.status)}</span>
                  ${payment.disputed ? html`<span class="small tc-danger d-b">Disputed</span>` : ''}
                  ${payment.livemode ? '' : html`<span class="small tc-muted d-b">Test</span>`}
                </td>
                <td class="small">${payment.description || payment.reference || '—'}</td>
                <td class="small tc-muted">${new Date(payment.createdAt).toLocaleString()}</td>
                <td class="small"><button class="link">Open</button></td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>

      ${this.total > PAGE_SIZE ? html`
        <div class="pager d-f">
          <button ?disabled=${this.offset === 0} @click=${() => this.page(-1)}>Newer</button>
          <span class="small tc-muted">${this.offset + 1}–${Math.min(this.offset + PAGE_SIZE, this.total)} of ${this.total}</span>
          <button ?disabled=${this.offset + PAGE_SIZE >= this.total} @click=${() => this.page(1)}>Older</button>
        </div>
      ` : ''}
    `;
  }

  render(){
    if(this.selected){
      return html`
        <button class="link mb" @click=${() => { this.selected = ''; this.load(); }}>
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

      ${this.#renderTable()}
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
    /*
      Styled by element rather than a class, after a class named "row" turned every table row into
      a flex container: kempo-css owns .row as its 12-column grid, so display:flex landed on the
      tr and detached the body cells from the header entirely. Nothing on a table element should
      carry a layout class from a framework that also lays out grids.
    */
    tbody tr { cursor: pointer; }
    tbody tr:hover { background: var(--c_bg__alt); }
    .pager { align-items: center; justify-content: flex-start; }
    .pager > * { margin-right: var(--spacer_h); }
  `;
}

customElements.define('k-pay-list', PaymentList);
