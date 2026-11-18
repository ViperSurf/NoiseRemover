import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { StereoBiquadFilter, calcHighPass, calcNotch } from './.tmp/math-biquad.mjs';
import { validateSettings, validateProfile, defaultSettings } from './.tmp/storage-store.mjs';

const FS = 48000;
const BLOCK = 128;

function rms(samples) {
  let s = 0;
  for (const x of samples) s += x * x;
  return Math.sqrt(s / samples.length);
}
function db(ratio) { return 20 * Math.log10(Math.max(1e-12, ratio)); }

/* ---------- Biquad math ---------- */

test('notch filter attenuates its center frequency by >28 dB', () => {
  const f = new StereoBiquadFilter();
  f.setCoeffs(calcNotch(60, 20, FS));
  const out = [];
  for (let n = 0; n < FS * 2; n++) {
    const x = 0.5 * Math.sin((2 * Math.PI * 60 * n) / FS);
    out.push(f.processL(x));
  }
  const steady = out.slice(FS); // second second, after settling
  assert.ok(db(rms(steady) / 0.3536) < -28, `attenuation was ${db(rms(steady) / 0.3536).toFixed(1)} dB`);
});

test('high-pass at 180 Hz strongly attenuates 50 Hz', () => {
  const f = new StereoBiquadFilter();
  f.setCoeffs(calcHighPass(180, 0.7071, FS));
  const out = [];
  for (let n = 0; n < FS * 2; n++) {
    out.push(f.processL(0.5 * Math.sin((2 * Math.PI * 50 * n) / FS)));
  }
  assert.ok(db(rms(out.slice(FS)) / 0.3536) < -15);
});

/* ---------- Settings validation ---------- */

test('settings schema validation accepts defaults and rejects garbage', () => {
  assert.ok(validateSettings(defaultSettings()));
  assert.equal(validateSettings({ version: 2 }), null);
  assert.equal(validateSettings(null), null);
  assert.equal(validateProfile({ enabled: true, preset: 'nope' }), null);
});

/* ---------- AudioWorklet processor (headless harness) ---------- */

function loadProcessor() {
  const code = readFileSync(new URL('./.tmp/processor.js', import.meta.url), 'utf8');
  let ProcessorCtor = null;
  const sandbox = {
    sampleRate: FS,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          onmessage: null,
          messages: [],
          postMessage(m) { this.messages.push(m); },
        };
      }
    },
    registerProcessor(name, ctor) { if (name === 'noise-remover-processor') ProcessorCtor = ctor; },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  assert.ok(ProcessorCtor, 'processor registered itself');
  return ProcessorCtor;
}

function makeProcessor(profile) {
  const Ctor = loadProcessor();
  const p = new Ctor();
  p.port.onmessage({ data: { type: 'UPDATE_CONFIG', profile, temporaryBypass: false } });
  return p;
}

function runBlocks(p, gen, blocks) {
  let lastOut = null;
  for (let b = 0; b < blocks; b++) {
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const v = gen(b * BLOCK + i);
      inL[i] = v; inR[i] = v;
    }
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    p.process([[inL, inR]], [[outL, outR]], {});
    lastOut = outL;
  }
  return lastOut;
}

const BASE_PROFILE = {
  enabled: true, preset: 'fan_ac', staticHissCut: 35, windFanHumCut: 90,
  cleanVoiceBoost: 100, monoMerge: false, calibratedNoiseFloorDb: -52, updatedAt: 0,
};

test('processor clamps a +12 dBFS spike to <= -1.0 dBFS (0.89126)', () => {
  const p = makeProcessor({ ...BASE_PROFILE, cleanVoiceBoost: 250 });
  const out = runBlocks(p, () => 4.0, 50); // constant +12 dBFS step
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 0.89126, `peak was ${peak}`);
});

test('processor attenuates a 60 Hz hum by >20 dB at windFanHumCut 90', () => {
  const p = makeProcessor(BASE_PROFILE);
  // 3 seconds of 60 Hz hum: filters settle, gates reach steady state
  const total = Math.floor((FS * 3) / BLOCK);
  const out = runBlocks(p, (n) => 0.5 * Math.sin((2 * Math.PI * 60 * n) / FS), total);
  const attenuation = db(rms(out) / 0.3536);
  assert.ok(attenuation < -20, `attenuation was ${attenuation.toFixed(1)} dB`);
});

test('processor reports idle bypass after >2s of silence', () => {
  const p = makeProcessor(BASE_PROFILE);
  p.port.onmessage({ data: { type: 'SET_METER_SUBSCRIPTION', subscribed: true } });
  runBlocks(p, () => 0, Math.floor((FS * 3) / BLOCK));
  const frames = p.port.messages.filter((m) => m.type === 'TELEMETRY_FRAME');
  assert.ok(frames.length > 0, 'telemetry frames were emitted');
  assert.equal(frames[frames.length - 1].idleBypassActive, true);
});

test('disabled processor is a clean passthrough', () => {
  const p = makeProcessor({ ...BASE_PROFILE, enabled: false });
  const out = runBlocks(p, (n) => 0.25 * Math.sin((2 * Math.PI * 440 * n) / FS), 10);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  assert.ok(Math.abs(peak - 0.25) < 0.01, `peak was ${peak}`);
});
