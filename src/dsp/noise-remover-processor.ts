import {
  StereoBiquadFilter,
  calcHighPass,
  calcNotch,
  calcBandPass,
  calcHighShelf,
  calcPeakingEq,
} from './math-biquad';
import { NoiseProfile, PresetId } from '../shared/types';

declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(name: string, processorCtor: typeof AudioWorkletProcessor): void;

const HYSTERESIS_DB = 6.0;
const HOLD_SECONDS = 0.150; // 150ms hold time
const SILENCE_THRESHOLD_LINEAR = 0.00056234; // -65 dBFS
const SILENCE_TIMEOUT_SECONDS = 2.0;
const LIMITER_CEILING = 0.8912509; // -1.0 dBFS

class NoiseRemoverProcessor extends AudioWorkletProcessor {
  // Configuration state
  private enabled = true;
  private temporaryBypass = false;
  private preset: PresetId = 'mic_hiss';
  private staticHissCut = 65;
  private windFanHumCut = 25;
  private cleanVoiceBoost = 115;
  private monoMerge = false;
  private calibratedNoiseFloorDb = -52;
  private meterSubscribed = false;

  // Stage A Filters (Wind HPF + 50/60/100/120Hz Hum Notches)
  private hpf = new StereoBiquadFilter();
  private notch50 = new StereoBiquadFilter();
  private notch60 = new StereoBiquadFilter();
  private notch100 = new StereoBiquadFilter();
  private notch120 = new StereoBiquadFilter();

  // Stage B Filters & Detectors (Fan 120-350Hz + High Hiss 4-14kHz)
  private fanDetectorBp = new StereoBiquadFilter();
  private hissDetectorHp = new StereoBiquadFilter();
  private fanSuppressorEq = new StereoBiquadFilter();
  private hissSuppressorShelf = new StereoBiquadFilter();

  // Stage C De-Esser (6-9kHz centered at 7.2kHz)
  private deEssDetectorBp = new StereoBiquadFilter();
  private deEssNotch = new StereoBiquadFilter();

  // Envelope & Hysteresis States (Zero-allocation scalars)
  private hissGateOpen = false;
  private hissHoldSamplesRemaining = 0;
  private hissGainEnvelope = 1.0;

  private fanGateOpen = false;
  private fanHoldSamplesRemaining = 0;
  private fanGainEnvelope = 1.0;

  private deEssEnvelope = 0.0;
  private currentMakeupGain = 1.15;
  private targetMakeupGain = 1.15;
  private limiterEnvelope = 0.0;

  // Ballistic coefficients
  private attackCoeff = 0;
  private releaseCoeff = 0;
  private holdSamplesMax = 0;

  // Silence Watchdog & Telemetry Decimation
  private silentSamplesAccum = 0;
  private silenceTimeoutSamples = 0;
  private isIdleBypassed = false;
  private telemetryFrameCounter = 0;

  // Auto-Tune (2-second profiler, 750 blocks of 128 frames @ 48kHz = 2.0s)
  private isAutoTuning = false;
  private autoTuneBlocksRemaining = 0;
  private autoTuneTotalBlocks = 750;
  private autoTuneHighEnergyAccum = 0;
  private autoTuneLowEnergyAccum = 0;
  private autoTuneFullEnergyAccum = 0;
  private autoTuneMinBlockRmsDb = 0;

  constructor() {
    super();
    const fs = sampleRate || 48000;
    this.holdSamplesMax = Math.floor(HOLD_SECONDS * fs);
    this.silenceTimeoutSamples = Math.floor(SILENCE_TIMEOUT_SECONDS * fs);
    this.attackCoeff = Math.exp(-1.0 / (0.0015 * fs));  // 1.5ms attack
    this.releaseCoeff = Math.exp(-1.0 / (0.085 * fs));  // 85ms release
    this.autoTuneTotalBlocks = Math.floor((2.0 * fs) / 128);

    // Initialize fixed detector bands
    this.fanDetectorBp.setCoeffs(calcBandPass(220, 1.2, fs));
    this.hissDetectorHp.setCoeffs(calcHighPass(4200, 0.707, fs));
    this.deEssDetectorBp.setCoeffs(calcBandPass(7200, 2.2, fs));

    this.recalculateStaticFilters();

    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'UPDATE_CONFIG') {
        this.applyProfile(msg.profile, msg.temporaryBypass);
      } else if (msg.type === 'SET_METER_SUBSCRIPTION') {
        this.meterSubscribed = Boolean(msg.subscribed);
      } else if (msg.type === 'START_AUTOTUNE') {
        this.startAutoTune();
      }
    };
  }

  private applyProfile(p: Partial<NoiseProfile>, tempBypass?: boolean): void {
    if (typeof p.enabled === 'boolean') this.enabled = p.enabled;
    if (typeof tempBypass === 'boolean') this.temporaryBypass = tempBypass;
    if (p.preset) this.preset = p.preset;
    if (typeof p.staticHissCut === 'number') this.staticHissCut = p.staticHissCut;
    if (typeof p.windFanHumCut === 'number') this.windFanHumCut = p.windFanHumCut;
    if (typeof p.cleanVoiceBoost === 'number') {
      this.cleanVoiceBoost = p.cleanVoiceBoost;
      this.targetMakeupGain = Math.max(1.0, Math.min(2.5, p.cleanVoiceBoost / 100));
    }
    if (typeof p.monoMerge === 'boolean') this.monoMerge = p.monoMerge;
    if (typeof p.calibratedNoiseFloorDb === 'number') {
      this.calibratedNoiseFloorDb = p.calibratedNoiseFloorDb;
    }
    this.recalculateStaticFilters();
  }

  private recalculateStaticFilters(): void {
    const fs = sampleRate || 48000;
    const windNorm = this.windFanHumCut / 100;

    // 1. Variable High-Pass Filter: 20Hz to 180Hz
    const hpfCutoff = 20 + windNorm * 160;
    this.hpf.setCoeffs(calcHighPass(hpfCutoff, 0.7071, fs));

    // 2. 50Hz & 60Hz Notch Filters + 100Hz & 120Hz Harmonics (narrow Q when low, deeper when high)
    const notchQ = 30 - windNorm * 18; // Q from 30 down to 12
    this.notch50.setCoeffs(calcNotch(50, notchQ, fs));
    this.notch60.setCoeffs(calcNotch(60, notchQ, fs));
    this.notch100.setCoeffs(calcNotch(100, notchQ * 1.2, fs));
    this.notch120.setCoeffs(calcNotch(120, notchQ * 1.2, fs));
  }

  private startAutoTune(): void {
    this.isAutoTuning = true;
    this.autoTuneBlocksRemaining = this.autoTuneTotalBlocks;
    this.autoTuneHighEnergyAccum = 0;
    this.autoTuneLowEnergyAccum = 0;
    this.autoTuneFullEnergyAccum = 0;
    this.autoTuneMinBlockRmsDb = 0;
  }

  public process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) {
      return true;
    }

    const inL = input[0];
    const inR = input.length > 1 ? input[1] : input[0];
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    const blockSize = inL.length;
    const fs = sampleRate || 48000;

    // Measure input energy for silence watchdog & metering
    let sumSqIn = 0;
    for (let i = 0; i < blockSize; i++) {
      const m = 0.5 * (inL[i] + inR[i]);
      sumSqIn += m * m;
    }
    const rmsIn = Math.sqrt(sumSqIn / blockSize);

    // Silence detection for 0% CPU idle bypass
    if (rmsIn < SILENCE_THRESHOLD_LINEAR) {
      this.silentSamplesAccum += blockSize;
      if (this.silentSamplesAccum >= this.silenceTimeoutSamples) {
        this.isIdleBypassed = true;
      }
    } else {
      this.silentSamplesAccum = 0;
      this.isIdleBypassed = false;
    }

    // Immediate zero-CPU passthrough if disabled, Hold-Bypassed, or Idle-Silent
    if (!this.enabled || this.temporaryBypass || (this.isIdleBypassed && !this.isAutoTuning)) {
      for (let i = 0; i < blockSize; i++) {
        outL[i] = inL[i];
        if (outR !== outL) outR[i] = inR[i];
      }
      this.emitTelemetryIfNeeded(rmsIn, rmsIn, 0);
      return true;
    }

    // Threshold calculation with 6 dB hysteresis gap
    const hissNorm = this.staticHissCut / 100;
    const windNorm = this.windFanHumCut / 100;

    // Open threshold capped safely at -26 dBFS so speech is never over-gated
    const hissOpenDb = Math.min(-26, this.calibratedNoiseFloorDb + hissNorm * 22);
    const hissCloseDb = hissOpenDb - HYSTERESIS_DB;
    const hissOpenLin = Math.pow(10, hissOpenDb / 20);
    const hissCloseLin = Math.pow(10, hissCloseDb / 20);

    const fanOpenDb = Math.min(-28, this.calibratedNoiseFloorDb + windNorm * 20);
    const fanCloseDb = fanOpenDb - HYSTERESIS_DB;
    const fanOpenLin = Math.pow(10, fanOpenDb / 20);
    const fanCloseLin = Math.pow(10, fanCloseDb / 20);

    const deEssActive = this.preset === 'mic_hiss' || this.preset === 'voice_focus';

    let sumSqOut = 0;
    let highBandEnergySum = 0;
    let lowBandEnergySum = 0;

    // Update dynamic filter coefficients once per 128-frame quantum (2.67ms rate)
    const hissAttenDb = -(1.0 - this.hissGainEnvelope) * (hissNorm * 24.0);
    const fanAttenDb = -(1.0 - this.fanGainEnvelope) * (windNorm * 18.0);
    this.hissSuppressorShelf.setCoeffs(calcHighShelf(3800, hissAttenDb, fs));
    this.fanSuppressorEq.setCoeffs(calcPeakingEq(210, 0.9, fanAttenDb, fs));

    const deEssCutDb = deEssActive ? -Math.min(6.0, this.deEssEnvelope * 18.0) : 0;
    this.deEssNotch.setCoeffs(calcPeakingEq(7200, 2.5, deEssCutDb, fs));

    for (let i = 0; i < blockSize; i++) {
      let sL = inL[i];
      let sR = inR[i];

      // 1. Optional Mono Merge
      if (this.monoMerge) {
        const mono = 0.5 * (sL + sR);
        sL = mono;
        sR = mono;
      }

      // 2. Stage A: Wind HPF + 50/60/100/120 Hz Hum Notches
      if (windNorm > 0.01) {
        sL = this.hpf.processL(sL);
        sR = this.hpf.processR(sR);
        sL = this.notch50.processL(this.notch60.processL(sL));
        sR = this.notch50.processR(this.notch60.processR(sR));
        if (windNorm > 0.25) {
          sL = this.notch100.processL(this.notch120.processL(sL));
          sR = this.notch100.processR(this.notch120.processR(sR));
        }
      }

      // 3. Stage B: Sidechain Detection + Dual-Threshold Hysteresis Expander
      const midMono = 0.5 * (sL + sR);
      const fanSig = Math.abs(this.fanDetectorBp.processL(midMono));
      const hissSig = Math.abs(this.hissDetectorHp.processL(midMono));

      lowBandEnergySum += fanSig * fanSig;
      highBandEnergySum += hissSig * hissSig;

      // Hiss Hysteresis State Machine (6 dB gap + 150ms hold)
      if (hissSig >= hissOpenLin) {
        this.hissGateOpen = true;
        this.hissHoldSamplesRemaining = this.holdSamplesMax;
      } else if (this.hissGateOpen) {
        if (hissSig >= hissCloseLin) {
          this.hissHoldSamplesRemaining = this.holdSamplesMax;
        } else if (this.hissHoldSamplesRemaining > 0) {
          this.hissHoldSamplesRemaining--;
        } else {
          this.hissGateOpen = false;
        }
      }

      const hissTarget = this.hissGateOpen ? 1.0 : Math.max(0.08, 1.0 - hissNorm * 0.92);
      const hissCoeff = hissTarget > this.hissGainEnvelope ? this.attackCoeff : this.releaseCoeff;
      this.hissGainEnvelope = hissCoeff * this.hissGainEnvelope + (1 - hissCoeff) * hissTarget;

      // Fan Drone Hysteresis State Machine (6 dB gap + 150ms hold)
      if (fanSig >= fanOpenLin) {
        this.fanGateOpen = true;
        this.fanHoldSamplesRemaining = this.holdSamplesMax;
      } else if (this.fanGateOpen) {
        if (fanSig >= fanCloseLin) {
          this.fanHoldSamplesRemaining = this.holdSamplesMax;
        } else if (this.fanHoldSamplesRemaining > 0) {
          this.fanHoldSamplesRemaining--;
        } else {
          this.fanGateOpen = false;
        }
      }

      const fanTarget = this.fanGateOpen ? 1.0 : Math.max(0.15, 1.0 - windNorm * 0.85);
      const fanCoeff = fanTarget > this.fanGainEnvelope ? this.attackCoeff : this.releaseCoeff;
      this.fanGainEnvelope = fanCoeff * this.fanGainEnvelope + (1 - fanCoeff) * fanTarget;

      // Apply Multi-Band Dynamic Suppression + Broadband Downward Expander Floor
      sL = this.fanSuppressorEq.processL(sL);
      sR = this.fanSuppressorEq.processR(sR);
      sL = this.hissSuppressorShelf.processL(sL);
      sR = this.hissSuppressorShelf.processR(sR);

      const broadbandFloorGain = 0.35 + 0.65 * Math.max(this.hissGainEnvelope, this.fanGainEnvelope);
      sL *= broadbandFloorGain;
      sR *= broadbandFloorGain;

      // 4. Stage C: Gentle Dynamic De-Esser (6–9 kHz)
      if (deEssActive) {
        const sibilance = Math.abs(this.deEssDetectorBp.processL(0.5 * (sL + sR)));
        const deEssThresh = 0.08;
        const over = Math.max(0, sibilance - deEssThresh);
        this.deEssEnvelope = 0.98 * this.deEssEnvelope + 0.02 * over;
        sL = this.deEssNotch.processL(sL);
        sR = this.deEssNotch.processR(sR);
      }

      // 5. Stage D: Clean Voice Boost + -1.0 dBFS Ear-Safety Brickwall Limiter
      this.currentMakeupGain = 0.995 * this.currentMakeupGain + 0.005 * this.targetMakeupGain;
      sL *= this.currentMakeupGain;
      sR *= this.currentMakeupGain;

      const peak = Math.max(Math.abs(sL), Math.abs(sR));
      if (peak > this.limiterEnvelope) {
        this.limiterEnvelope = peak; // Instantaneous peak catch
      } else {
        this.limiterEnvelope = 0.9992 * this.limiterEnvelope;
      }

      if (this.limiterEnvelope > LIMITER_CEILING) {
        const limGain = LIMITER_CEILING / this.limiterEnvelope;
        sL *= limGain;
        sR *= limGain;
      }

      // Final soft-knee ceiling guard
      outL[i] = Math.max(-LIMITER_CEILING, Math.min(LIMITER_CEILING, sL));
      if (outR !== outL) {
        outR[i] = Math.max(-LIMITER_CEILING, Math.min(LIMITER_CEILING, sR));
      }

      const outMono = 0.5 * (outL[i] + outR[i]);
      sumSqOut += outMono * outMono;
    }

    const rmsOut = Math.sqrt(sumSqOut / blockSize);
    const totalAttenDb = Math.min(40, Math.abs(hissAttenDb) * 0.65 + Math.abs(fanAttenDb) * 0.35);

    // Handle 2-Second Auto-Tune Profiling if active
    if (this.isAutoTuning) {
      this.processAutoTuneStep(rmsIn, highBandEnergySum / blockSize, lowBandEnergySum / blockSize);
    }

    this.emitTelemetryIfNeeded(rmsIn, rmsOut, totalAttenDb);
    return true;
  }

  private processAutoTuneStep(rmsIn: number, highSq: number, lowSq: number): void {
    const blockDb = 20 * Math.log10(Math.max(1e-7, rmsIn));
    if (this.autoTuneBlocksRemaining === this.autoTuneTotalBlocks || blockDb < this.autoTuneMinBlockRmsDb) {
      this.autoTuneMinBlockRmsDb = blockDb;
    }
    this.autoTuneHighEnergyAccum += Math.sqrt(highSq);
    this.autoTuneLowEnergyAccum += Math.sqrt(lowSq);
    this.autoTuneFullEnergyAccum += rmsIn;
    this.autoTuneBlocksRemaining--;

    if (this.autoTuneBlocksRemaining <= 0) {
      this.isAutoTuning = false;
      const n = this.autoTuneTotalBlocks;
      const avgHighDb = 20 * Math.log10(Math.max(1e-7, this.autoTuneHighEnergyAccum / n));
      const avgLowDb = 20 * Math.log10(Math.max(1e-7, this.autoTuneLowEnergyAccum / n));

      // Safely clamp noise floor between -68 dBFS and -34 dBFS so speech is never gated
      const safeFloorDb = Math.max(-68, Math.min(-34, this.autoTuneMinBlockRmsDb + 3.0));
      const computedHissCut = Math.round(Math.max(25, Math.min(88, (avgHighDb + 75) * 1.6)));
      const computedWindCut = Math.round(Math.max(20, Math.min(85, (avgLowDb + 70) * 1.5)));

      this.calibratedNoiseFloorDb = safeFloorDb;
      this.staticHissCut = computedHissCut;
      this.windFanHumCut = computedWindCut;
      this.preset = 'custom';
      this.recalculateStaticFilters();

      this.port.postMessage({
        type: 'AUTOTUNE_FINISHED',
        calibratedNoiseFloorDb: safeFloorDb,
        staticHissCut: computedHissCut,
        windFanHumCut: computedWindCut,
      });
    }
  }

  private emitTelemetryIfNeeded(rmsIn: number, rmsOut: number, attenDb: number): void {
    if (!this.meterSubscribed && !this.isAutoTuning) return;
    this.telemetryFrameCounter++;
    // Emit every 12 blocks (~32ms = ~31.25 Hz)
    if (this.telemetryFrameCounter < 12) return;
    this.telemetryFrameCounter = 0;

    const inputRmsDb = 20 * Math.log10(Math.max(1e-5, rmsIn));
    const outputRmsDb = 20 * Math.log10(Math.max(1e-5, rmsOut));
    const autoTuneProgress = this.isAutoTuning
      ? 1.0 - this.autoTuneBlocksRemaining / this.autoTuneTotalBlocks
      : null;

    this.port.postMessage({
      type: 'TELEMETRY_FRAME',
      inputRmsDb,
      outputRmsDb,
      attenuationDb: this.enabled && !this.temporaryBypass ? attenDb : 0,
      idleBypassActive: this.isIdleBypassed,
      autoTuneProgress,
    });
  }
}

registerProcessor('noise-remover-processor', NoiseRemoverProcessor);
