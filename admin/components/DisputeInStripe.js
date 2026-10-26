import ButtonControl from '/kempo-ui/components/controls/ButtonControl.js';
import { html } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';

/*
  Opens a dispute in the processor's own dashboard, in a new tab, where it is answered. The link is the row's
  `dashboardUrl`; a row without one does nothing.

    <k-pay-dispute-stripe slot="after"></k-pay-dispute-stripe>
*/
export default class DisputeInStripe extends ButtonControl {
  get record(){
    const index = this.closest('.record')?.dataset?.index;
    return index === undefined ? null : this.host?.records?.[index] ?? null;
  }

  connectedCallback(){
    super.connectedCallback();
    if(!this.hasAttribute('title')) this.title = 'View in Stripe';
  }

  handleAction(){
    const url = this.record?.dashboardUrl;
    if(url) window.open(url, '_blank', 'noopener');
  }

  render(){ return html`<slot><k-icon name="open_in_new"></k-icon></slot>`; }
}

customElements.define('k-pay-dispute-stripe', DisputeInStripe);
