import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus, type GameEventMap } from '../src/app/events.ts';
import { AudioManager } from '../src/audio/AudioManager.ts';
import { SettingsScreen } from '../src/ui/screens/SettingsScreen.ts';

class MockAudioParam {
  value = 0;
  setValueAtTime = vi.fn((val: number) => { this.value = val; });
  setTargetAtTime = vi.fn((val: number) => { this.value = val; });
  exponentialRampToValueAtTime = vi.fn((val: number) => { this.value = val; });
  linearRampToValueAtTime = vi.fn((val: number) => { this.value = val; });
}

class MockAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockOscillatorNode extends MockAudioNode {
  type: OscillatorType = 'sine';
  frequency = new MockAudioParam();
  start = vi.fn();
  stop = vi.fn();
}

class MockGainNode extends MockAudioNode {
  gain = new MockAudioParam();
}

class MockBiquadFilterNode extends MockAudioNode {
  type: BiquadFilterType = 'lowpass';
  frequency = new MockAudioParam();
  Q = new MockAudioParam();
}

class MockAudioBufferSourceNode extends MockAudioNode {
  buffer: any = null;
  loop = false;
  start = vi.fn();
  stop = vi.fn();
}

class MockAudioBuffer {
  duration: number;
  sampleRate: number;
  private channelData: Float32Array;

  constructor(_channels: number, length: number, sampleRate: number) {
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channelData = new Float32Array(length);
  }

  getChannelData() {
    return this.channelData;
  }
}

class MockAudioContext {
  state: AudioContextState = 'running';
  currentTime = 10;
  sampleRate = 44100;
  destination = new MockAudioNode();

  createOscillator() { return new MockOscillatorNode(); }
  createGain() { return new MockGainNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createBufferSource() { return new MockAudioBufferSourceNode(); }
  createBuffer(c: number, l: number, r: number) { return new MockAudioBuffer(c, l, r); }
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });
}

describe('SettingsScreen Audio Controls', () => {
  let origWindow: unknown;
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    origWindow = (globalThis as any).window;
    mockStorage = {};

    (globalThis as any).localStorage = {
      getItem: (k: string) => mockStorage[k] ?? null,
      setItem: (k: string, v: string) => { mockStorage[k] = v; },
      removeItem: (k: string) => { delete mockStorage[k]; },
      clear: () => { mockStorage = {}; }
    };

    (globalThis as any).window = {
      AudioContext: MockAudioContext,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      localStorage: (globalThis as any).localStorage
    };
  });

  afterEach(() => {
    (globalThis as any).window = origWindow;
    vi.restoreAllMocks();
  });

  it('binds to AudioManager and reacts to volume adjustments', () => {
    const events = new EventBus<GameEventMap>();
    const audio = new AudioManager(events);
    const screen = new SettingsScreen();

    screen.bindAudio(audio, events);

    // Initial state reflection
    expect(audio.masterVolume).toBeCloseTo(0.8);
    expect(audio.muted).toBe(false);

    // Simulate volume slider change
    (screen as any).handleVolumeInput({ target: { value: '45' } } as any);
    expect(audio.masterVolume).toBeCloseTo(0.45);

    // Simulate mute toggle
    (screen as any).handleToggleMute();
    expect(audio.muted).toBe(true);

    // Simulate test horn
    const hornSpy = vi.spyOn(audio, 'testHorn');
    (screen as any).handleTestHorn();
    expect(hornSpy).toHaveBeenCalledTimes(1);

    // Simulate external audio event
    audio.setVolume(0.9);
    expect(audio.masterVolume).toBeCloseTo(0.9);

    audio.dispose();
  });

  it('renders audio panel in html template', () => {
    const events = new EventBus<GameEventMap>();
    const audio = new AudioManager(events);
    const screen = new SettingsScreen();
    screen.bindAudio(audio, events);

    const templateResult = screen.render();
    expect(templateResult).toBeDefined();

    // Verify strings in Lit template
    const renderedStrings = (templateResult as any).strings.join(' ');
    expect(renderedStrings).toContain('SETTINGS & CONTROLS');
    expect(renderedStrings).toContain('Audio Settings');
    expect(renderedStrings).toContain('Master Volume');
    expect(renderedStrings).toContain('TEST HORN');

    audio.dispose();
  });
});
