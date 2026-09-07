import { html, css } from 'lit';
import { HudComponent } from './HudComponent.ts';

/** Transient banner for pickups, steals, deliveries, wins. */
export class Banner extends HudComponent {
  static override styles = css`
    :host { display:block; position:absolute; top:42%; left:50%;
      transform:translate(-50%,-50%); pointer-events:none; z-index:25; }
    .banner { font-family:'Russo One',sans-serif; font-size:clamp(32px, 5.5vw, 60px); color:#fff;
      text-shadow:0 0 24px rgba(255,100,0,.8), 0 0 6px #000, 0 4px 0 #000;
      opacity:0; transform:scale(0.85);
      transition:opacity .2s ease-out, transform .2s cubic-bezier(0.18, 0.89, 0.32, 1.28);
      letter-spacing: 0.05em; text-align: center; white-space: nowrap; }
    .banner.show { opacity:1; transform:scale(1); }
    .banner.go { color:#38ef7d; text-shadow:0 0 32px rgba(56,239,125,.9), 0 0 8px #000; font-size:clamp(48px, 8vw, 92px); }
    .banner.count { font-size:clamp(52px, 9vw, 96px); color:#ffbe0b; text-shadow:0 0 32px rgba(255,190,11,.9), 0 0 8px #000; }
  `;

  private hideTimer: number | null = null;
  protected message = '';
  protected visible = false;

  show(text: string, ms = 1200): void {
    this.message = text;
    this.visible = false;
    this.requestUpdate();
    if (this.hideTimer) clearTimeout(this.hideTimer);
    // double-rAF ensures clean re-trigger of scale pop animation
    requestAnimationFrame(() => {
      this.visible = true;
      this.requestUpdate();
    });
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
    const isGo = this.message === 'GO!';
    const isCount = /^[1-9]$/.test(this.message);
    const cls = `banner ${this.visible ? 'show' : ''} ${isGo ? 'go' : ''} ${isCount ? 'count' : ''}`;
    return html`<div class="${cls}">${this.message}</div>`;
  }
}
customElements.define('sr-banner', Banner);
