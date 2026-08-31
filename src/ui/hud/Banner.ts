import { html, css } from 'lit';
import { HudComponent } from './HudComponent.ts';

/** Transient banner for pickups, steals, deliveries, wins. */
export class Banner extends HudComponent {
  static override styles = css`
    :host { display:block; position:absolute; top:50%; left:50%;
      transform:translate(-50%,-50%); pointer-events:none; z-index:5; }
    .banner { font-family:'Russo One',sans-serif; font-size:40px; color:#ffd;
      text-shadow:0 0 16px #f80, 0 0 4px #000; opacity:0; transition:opacity .4s; }
    .banner.show { opacity:1; }
  `;

  private hideTimer: number | null = null;
  protected message = '';
  protected visible = false;

  show(text: string, ms = 1200): void {
    this.message = text;
    this.visible = true;
    this.requestUpdate();
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.visible = false;
      this.requestUpdate();
    }, ms);
  }

  override disconnectedCallback(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    super.disconnectedCallback();
  }

  override render() {
    return html`<div class="banner ${this.visible ? 'show' : ''}">${this.message}</div>`;
  }
}
customElements.define('sr-banner', Banner);
