/**
 * The focused element, reached through shadow roots, and a guard that says
 * whether the player is typing in a text field. Both are used by the input
 * sources (KeyboardSource) so game hotkeys keep their hands off while
 * someone is typing a room code or a place name.
 *
 * `document.activeElement` retargets to the shadow HOST, so a field inside a
 * Lit component reads as <SR-LOBBY>, never <INPUT>. Every "is the player
 * typing?" guard therefore said no and the game ate the keystroke: the room
 * code box could not accept the digits its own codes contain, and WASD steered
 * the car while you typed a place name.
 */
function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** True while focus is in a text field, so game hotkeys must keep their hands off. */
export function isTypingInField(): boolean {
  const el = deepActiveElement();
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el instanceof HTMLElement && el.isContentEditable);
}
