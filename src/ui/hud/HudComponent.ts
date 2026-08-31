/**
 * Base class for HUD components: subscribes to the store and re-renders on
 * every snapshot. Lit handles the DOM diffing.
 */
import { LitElement } from 'lit';
import type { HudSnapshot, Store } from '../../app/store.ts';

export class HudComponent extends LitElement {
  protected snapshot: HudSnapshot | null = null;
  private unsubscribe: (() => void) | null = null;

  bind(store: Store<HudSnapshot>): this {
    this.unsubscribe?.();
    this.unsubscribe = store.subscribe(s => {
      this.snapshot = s;
      this.requestUpdate();
    });
    return this;
  }

  override disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    super.disconnectedCallback();
  }
}
