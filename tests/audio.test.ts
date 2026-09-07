import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioManager } from '../src/audio/AudioManager.ts';
import { EngineAudio } from '../src/audio/EngineAudio.ts';
import { TireAudio } from '../src/audio/TireAudio.ts';
import { ImpactAudio } from '../src/audio/ImpactAudio.ts';
import { StingerAudio } from '../src/audio/StingerAudio.ts';
import { ProximityAudio } from '../src/audio/ProximityAudio.ts';
import { HornAudio } from '../src/audio/HornAudio.ts';
import { EventBus, type GameEventMap } from '../src/app/events.ts';
import { Vector3 } from 'three';
import type { VehicleActor } from '../src/app/Game.ts';
import type { WorldView } from '../src/app/WorldView.ts';

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

describe('Procedural Game Audio System', () => {
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

  describe('EngineAudio', () => {
    it('scales pitch and cutoff frequency with speed and throttle load', () => {
      const ctx = new MockAudioContext() as unknown as AudioContext;
      const dest = new MockAudioNode() as unknown as AudioNode;
      const engine = new EngineAudio(ctx, dest);

      engine.start();

      // At idle stopped:
      engine.update(0.016, 0, 45, 0, true, true);
      const idleFreq = (engine as any).osc1.frequency.value;
      const idleCutoff = (engine as any).filter.frequency.value;
      expect(idleFreq).toBeGreaterThanOrEqual(45);
      expect(idleCutoff).toBeLessThanOrEqual(500);
      expect((engine as any).filter.Q.value).toBeCloseTo(0.75);
      expect((engine as any).osc1Gain.gain.value).toBeCloseTo(0.35);
      expect((engine as any).osc2Gain.gain.value).toBeCloseTo(0.75);

      // At top speed under full throttle:
      for (let i = 0; i < 60; i++) {
        engine.update(0.016, 45, 45, 1.0, true, true);
      }
      const highFreq = (engine as any).osc1.frequency.value;
      const highCutoff = (engine as any).filter.frequency.value;
      const highGain = (engine as any).gain.gain.value;

      expect(highFreq).toBeGreaterThan(idleFreq * 2);
      expect(highCutoff).toBeGreaterThan(idleCutoff * 2);
      expect(highCutoff).toBeLessThanOrEqual(1000); // capped under 1000Hz to eliminate irritating buzz
      expect(highGain).toBeLessThan(0.15); // quiet and unobtrusive in mix

      engine.stop();
    });

    it('flares engine RPM when airborne under throttle', () => {
      const ctx = new MockAudioContext() as unknown as AudioContext;
      const dest = new MockAudioNode() as unknown as AudioNode;
      const engine = new EngineAudio(ctx, dest);

      engine.start();

      // In the air (wheels free) with throttle held:
      for (let i = 0; i < 40; i++) {
        engine.update(0.016, 10, 45, 1.0, false, true);
      }

      expect((engine as any).currentRpm).toBeGreaterThan(0.8);
      engine.stop();
    });
  });

  describe('TireAudio', () => {
    it('ramps up screech gain during high lateral slip', () => {
      const ctx = new MockAudioContext() as unknown as AudioContext;
      const dest = new MockAudioNode() as unknown as AudioNode;
      const tire = new TireAudio(ctx, dest);
      tire.start();

      // Driving straight on ground: no screech
      tire.update(25, 0.2, false, true);
      expect((tire as any).gain.gain.value).toBe(0);

      // Drifting sideways at 12 m/s:
      tire.update(25, 12.0, false, true);
      expect((tire as any).gain.gain.value).toBeGreaterThan(0.07);

      // Handbrake turn at speed:
      tire.update(20, 1.0, true, true);
      expect((tire as any).gain.gain.value).toBeGreaterThan(0.04);

      // Airborne: silence
      tire.update(25, 15.0, true, false);
      expect((tire as any).gain.gain.value).toBe(0);

      tire.stop();
    });
  });

  describe('ImpactAudio', () => {
    it('synthesizes landing thud and crash audio without errors', () => {
      const ctx = new MockAudioContext() as unknown as AudioContext;
      const dest = new MockAudioNode() as unknown as AudioNode;
      const impacts = new ImpactAudio(ctx, dest);

      expect(() => impacts.playLanding(18)).not.toThrow();
      expect(() => impacts.playCrash(22)).not.toThrow();
      expect(() => impacts.playRam(15)).not.toThrow();
    });
  });

  describe('StingerAudio', () => {
    it('plays pickup, stolen, delivered, and countdown stingers', () => {
      const ctx = new MockAudioContext() as unknown as AudioContext;
      const dest = new MockAudioNode() as unknown as AudioNode;
      const stingers = new StingerAudio(ctx, dest);

      expect(() => stingers.playPickup()).not.toThrow();
      expect(() => stingers.playStolen()).not.toThrow();
      expect(() => stingers.playDelivered()).not.toThrow();
      expect(() => stingers.playDropped()).not.toThrow();
      expect(() => stingers.playWrecked()).not.toThrow();
      expect(() => stingers.playCountdown(3)).not.toThrow();
      expect(() => stingers.playCountdown(0)).not.toThrow();
      expect(() => stingers.playWin()).not.toThrow();
      expect(() => stingers.playAlert()).not.toThrow();
    });
  });

  describe('ProximityAudio', () => {
    it('pulses beacon tone when carrying contraband near delivery base', () => {
      const ctx = new MockAudioContext() as unknown as AudioContext;
      const dest = new MockAudioNode() as unknown as AudioNode;
      const proximity = new ProximityAudio(ctx, dest);

      // Far away (>160m): no pulse
      proximity.update(true, 250);
      expect((proximity as any).lastPulseTime).toBe(0);

      // Near base (50m) while carrying:
      (ctx as any).currentTime = 10;
      proximity.update(true, 50);
      expect((proximity as any).lastPulseTime).toBe(10);

      // Not carrying: no pulse
      (ctx as any).currentTime = 15;
      proximity.update(false, 30);
      expect((proximity as any).lastPulseTime).toBe(10);
    });
  });

  describe('HornAudio', () => {
    it('starts and stops dual-tone horn', () => {
      const ctx = new MockAudioContext() as unknown as AudioContext;
      const dest = new MockAudioNode() as unknown as AudioNode;
      const horn = new HornAudio(ctx, dest);

      horn.start();
      expect((horn as any).isHonking).toBe(true);

      horn.stop();
      expect((horn as any).isHonking).toBe(false);
    });
  });

  describe('AudioManager Orchestrator & Settings', () => {
    it('manages mute and volume state with localStorage persistence', () => {
      const events = new EventBus<GameEventMap>();
      const audio = new AudioManager(events);
      const audioEvents: { muted: boolean; volume: number }[] = [];
      events.on('audio:change', e => audioEvents.push(e));

      expect(audio.muted).toBe(false);
      expect(audio.masterVolume).toBeCloseTo(0.6);

      // Toggle mute
      audio.toggleMute();
      expect(audio.muted).toBe(true);
      expect(mockStorage['smugglers_audio_muted']).toBe('true');
      expect(audioEvents.length).toBe(1);
      expect(audioEvents[0]).toEqual({ muted: true, volume: 0.6 });

      // Change volume
      audio.setVolume(0.5);
      expect(audio.masterVolume).toBe(0.5);
      expect(mockStorage['smugglers_audio_volume']).toBe('0.5');
      expect(audioEvents.length).toBe(2);
      expect(audioEvents[1]).toEqual({ muted: true, volume: 0.5 });

      // Unmute
      audio.setMuted(false);
      expect(audio.muted).toBe(false);
      expect(mockStorage['smugglers_audio_muted']).toBe('false');
      expect(audioEvents.length).toBe(3);
      expect(audioEvents[2]).toEqual({ muted: false, volume: 0.5 });

      // testHorn
      const hornStartSpy = vi.spyOn((audio as any).horn, 'start');
      audio.testHorn();
      expect(hornStartSpy).toHaveBeenCalledTimes(1);

      audio.dispose();
    });

    it('subscribes to GameEvents and dispatches stingers', () => {
      const events = new EventBus<GameEventMap>();
      const audio = new AudioManager(events);

      const playPickupSpy = vi.spyOn((audio as any).stingers, 'playPickup');
      const playDeliveredSpy = vi.spyOn((audio as any).stingers, 'playDelivered');
      const playStolenSpy = vi.spyOn((audio as any).stingers, 'playStolen');
      const playCountdownSpy = vi.spyOn((audio as any).stingers, 'playCountdown');
      const playWinSpy = vi.spyOn((audio as any).stingers, 'playWin');

      events.emit('contraband:pickup', { vehicleId: 0 });
      expect(playPickupSpy).toHaveBeenCalledTimes(1);

      events.emit('contraband:delivered', { team: 0 });
      expect(playDeliveredSpy).toHaveBeenCalledTimes(1);

      events.emit('contraband:stolen', { attackerId: 1, victimId: 0 });
      expect(playStolenSpy).toHaveBeenCalledTimes(1);

      events.emit('match:countdown', { n: 2 });
      expect(playCountdownSpy).toHaveBeenCalledWith(2);

      events.emit('match:win', { team: 1 });
      expect(playWinSpy).toHaveBeenCalledTimes(1);

      audio.dispose();
    });

    it('runs frame update with vehicle body and inputs', () => {
      const events = new EventBus<GameEventMap>();
      const audio = new AudioManager(events);

      const dummyActor: VehicleActor = {
        body: {
          cfg: { maxSpeed: 45 },
          stats: { maxSpeed: 1.0 },
          speed: 25,
          lateralSlip: 4.5,
          onGround: true,
          jumpHeld: false,
          lastImpact: { kind: 'landing', speed: 12 },
          pos: new Vector3(100, 10, 100)
        } as any,
        team: 0,
        isPlayer: true,
        label: 'Player',
        control: 'local',
        brain: null
      };

      // A nearby bot whose crash should be audible (attenuated by distance),
      // and a far one whose crash should be silent past the audible range.
      const nearBot: VehicleActor = {
        body: {
          lastImpact: { kind: 'vehicle', speed: 14 },
          pos: new Vector3(130, 10, 100)
        } as any,
        team: 1,
        isPlayer: false,
        label: 'NearBot',
        control: 'bot',
        brain: null
      };
      const farBot: VehicleActor = {
        body: {
          lastImpact: { kind: 'building', speed: 20 },
          pos: new Vector3(100 + 300, 10, 100)
        } as any,
        team: 1,
        isPlayer: false,
        label: 'FarBot',
        control: 'bot',
        brain: null
      };

      const dummyWorld: WorldView = {
        vehicles: [dummyActor, nearBot, farBot],
        player: dummyActor,
        state: null as any,
        alpha: 0,
        matchPhase: 'playing' as any,
        terrainProvider: null as any,
        navMarker: () => null,
        lineOfSight: () => 1
      };

      const dummyState = {
        scores: { 0: 0, 1: 0 },
        winner: null,
        contraband: [{ carrier: dummyActor.body, id: 0, pos: dummyActor.body.pos, lastTransfer: 0, delivered: false }],
        bases: { 0: new Vector3(120, 10, 120), 1: new Vector3(-100, 10, -100) }
      };

      expect(() => {
        audio.update(0.016, dummyWorld, { throttle: 0.8, brake: 0, steer: 0.2, handbrake: false, jump: false }, dummyState as any, true);
      }).not.toThrow();

      audio.dispose();
    });

    it('sets up pointerdown, keydown, and touchstart unlock listeners without removing them until running', async () => {
      const addedListeners: Record<string, Function> = {};
      const removedListeners: Record<string, Function> = {};

      (globalThis as any).window.addEventListener = vi.fn((event: string, handler: Function) => {
        addedListeners[event] = handler;
      });
      (globalThis as any).window.removeEventListener = vi.fn((event: string, handler: Function) => {
        removedListeners[event] = handler;
      });

      class SuspendedAudioContext extends MockAudioContext {
        override state: AudioContextState = 'suspended';
      }
      (globalThis as any).window.AudioContext = SuspendedAudioContext;

      const events = new EventBus<GameEventMap>();
      const audio = new AudioManager(events);

      expect(addedListeners['pointerdown']).toBeDefined();
      expect(addedListeners['keydown']).toBeDefined();
      expect(addedListeners['touchstart']).toBeDefined();
      expect(addedListeners['gamepadconnected']).toBeUndefined();

      // Trigger pointerdown
      addedListeners['pointerdown']!();
      await Promise.resolve();

      expect(removedListeners['pointerdown']).toBeDefined();
      expect(removedListeners['keydown']).toBeDefined();
      expect(removedListeners['touchstart']).toBeDefined();

      audio.dispose();
    });
  });
});
