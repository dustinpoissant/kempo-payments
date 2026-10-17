import DashboardWidget from '/kempo/components/DashboardWidget.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import { getSummary } from '/payments/sdk.js';

/*
  Amounts are whole numbers of the currency's smallest unit, so they are divided by what that currency
  uses (100 for dollars, 1 for yen) before display.
*/
const money = (amount, currency) => {
  const format = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() });
  return format.format(amount / 10 ** format.resolvedOptions().maximumFractionDigits);
};

/*
  Captured and refunded money per currency, how many payments there are, and any open disputes.
*/
export default class PaymentsWidget extends DashboardWidget {
  static properties = {
    ...DashboardWidget.properties,
    currencies: { state: true },
    disputed: { state: true }
  };

  constructor(){
    super();
    this.currencies = [];
    this.disputed = 0;
    this.cta = { label: 'View payments', iconSrc: '/admin/extension/kempo-payments/icons/credit-card.svg', href: '/admin/extension/kempo-payments/' };
  }

  /*
    Public Methods
  */

  load = async () => {
    const { byStatus, disputed } = await this.unwrap(getSummary());
    const totals = {};
    byStatus.forEach(({ currency, count, captured, refunded }) => {
      const entry = totals[currency] ??= { currency, count: 0, captured: 0, refunded: 0 };
      entry.count += count;
      entry.captured += captured;
      entry.refunded += refunded;
    });
    this.currencies = Object.values(totals);
    this.disputed = disputed;
  };

  /*
    Rendering
  */

  renderContent(){
    if(!this.currencies.length) return html`<p class="tc-muted">No payments yet.</p>`;
    return html`
      ${this.currencies.map(({ currency, count, captured, refunded }) => html`
        <div class="d-f mb">
          <div class="flex"><div class="h2 m0">${money(captured, currency)}</div><div class="small tc-muted">Captured (${currency.toUpperCase()})</div></div>
          <div class="flex"><div class="h2 m0">${money(refunded, currency)}</div><div class="small tc-muted">Refunded</div></div>
          <div class="flex"><div class="h2 m0">${count}</div><div class="small tc-muted">Payments</div></div>
        </div>
      `)}
      ${this.disputed ? html`<p class="tc-danger" role="alert">${this.disputed} disputed</p>` : nothing}
    `;
  }
}

customElements.define('k-pay-widget', PaymentsWidget);
