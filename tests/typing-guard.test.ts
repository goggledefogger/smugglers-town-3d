import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isTypingInField } from '../src/ui/controls.ts';

/**
 * The garage/gate screens are Lit components, so a text field inside one reads
 * from `document.activeElement` as its shadow HOST (e.g. <SR-RELOCATE>), never
 * as <INPUT>. `e.target instanceof HTMLInputElement` guards on window-level
 * hotkey listeners therefore fail open and the game eats keystrokes typed into
 * the place search box (T for teleport, E for experiment cycle, both with
 * preventDefault, so those letters could not be typed at all).
 *
 * These tests stub `document` the way settings.test.ts stubs `window`, driving
 * `deepActiveElement` through a fake shadow root chain.
 */

interface FakeElement {
  tagName: string;
  shadowRoot: { activeElement: FakeElement | null } | null;
  isContentEditable?: boolean;
}

let origDocument: unknown;

function setActive(el: FakeElement | null): void {
  (globalThis as any).document = {
    activeElement: el
  };
}

/**
 * controls.ts probes `el instanceof HTMLElement` for isContentEditable; node
 * has no DOM globals, so give the stubs a stand-in class to be instanceof
 */
class FakeHTMLElement {}
(globalThis as any).HTMLElement = FakeHTMLElement;

/** contenteditable fakes are instances of the stand-in so the instanceof probe works */
function editableEl(): FakeElement {
  const el = new FakeHTMLElement() as unknown as FakeElement & { isContentEditable?: boolean };
  el.tagName = 'DIV';
  el.isContentEditable = true;
  return el;
}

function plainBody(): FakeElement {
  return { tagName: 'BODY', shadowRoot: null };
}

describe('isTypingInField', () => {
  beforeEach(() => {
    origDocument = (globalThis as any).document;
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
  });

  it('returns false when nothing is focused', () => {
    setActive(null);
    expect(isTypingInField()).toBe(false);
  });

  it('returns false for plain body focus', () => {
    setActive(plainBody());
    expect(isTypingInField()).toBe(false);
  });

  it('returns true for a light-DOM input', () => {
    setActive({ tagName: 'INPUT', shadowRoot: null });
    expect(isTypingInField()).toBe(true);
  });

  it('returns true for a textarea and contenteditable in the light DOM', () => {
    setActive({ tagName: 'TEXTAREA', shadowRoot: null });
    expect(isTypingInField()).toBe(true);
    setActive(editableEl());
    expect(isTypingInField()).toBe(true);
  });

  it('sees an input focused inside a shadow root (the Lit screens)', () => {
    // the regression from the garage search box: activeElement retargets to the
    // host, so the old instanceof-style guard in main.ts read this as "not
    // typing" and the T/E hotkeys swallowed the letters
    const input: FakeElement = { tagName: 'INPUT', shadowRoot: null };
    const host: FakeElement = {
      tagName: 'SR-RELOCATE',
      shadowRoot: { activeElement: input }
    };
    setActive(host);
    expect(isTypingInField()).toBe(true);
  });

  it('sees through nested shadow roots', () => {
    const input: FakeElement = { tagName: 'INPUT', shadowRoot: null };
    const inner: FakeElement = { tagName: 'SR-INNER', shadowRoot: { activeElement: input } };
    const outer: FakeElement = { tagName: 'SR-OUTER', shadowRoot: { activeElement: inner } };
    setActive(outer);
    expect(isTypingInField()).toBe(true);
  });

  it('returns false when a shadow host has focus but not a field (cards, buttons)', () => {
    const card: FakeElement = { tagName: 'DIV', shadowRoot: null };
    const host: FakeElement = {
      tagName: 'SR-INTRO',
      shadowRoot: { activeElement: card }
    };
    setActive(host);
    expect(isTypingInField()).toBe(false);
  });
});
