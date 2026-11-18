/**
 * Firefox-only audio injector.
 *
 * Firefox has no `chrome.tabCapture` / `chrome.offscreen`, so the background
 * router injects this script into the tab on user action (activeTab). It
 * builds the same AudioWorklet DSP graph in the page, one shared graph for
 * every <audio>/<video> element in the document:
 *
 *   HTMLMediaElement -> MediaElementAudioSourceNode -> NoiseRemover Worklet
 *     -> DynamicsCompressor (safety) -> AudioContext.destination
 *
 * Cross-origin note: media served without CORS headers is tainted once it is
 * routed through Web Audio and may fall silent in some browsers. Elements
 * that already carry `crossorigin="anonymous"` (most large lecture/streaming
 * hosts) route cleanly; for others we leave the element untouched until it
 * starts playing and we can hook it, and the Hold/Original bypass in the
 * background profile restores a direct wire instantly.
 */
import { NoiseProfile } from '../shared/types';

interface InjectedState {
  ctx: AudioContext | null;
  workletNode: AudioWorkletNode | null;
  safetyLimiter: DynamicsCompressorNode | null;
  sources: Map<HTMLMediaElement, MediaElementAudioSourceNode>;
  hooked: WeakSet<HTMLMediaElement>;
  profile: NoiseProfile | null;
  bypassed: boolean;
  workletReady: Promise<void> | null;
}

const FLAG = '__noiseRemoverFirefoxInjected';
const w = window as unknown as Record<string, unknown>;
if (w[FLAG]) {
  // Already injected into this tab — the runtime message listener below is
  // live, so a second copy would only double-hook media elements.
} else {
  w[FLAG] = true;

  const state: InjectedState = {
    ctx: null,
    workletNode: null,
    safetyLimiter: null,
    sources: new Map(),
    hooked: new WeakSet(),
    profile: null,
    bypassed: true,
    workletReady: null,
  };

  async function ensureGraph(): Promise<void> {
    if (state.ctx) return;
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    state.ctx = ctx;

    state.workletReady = (async () => {
      await ctx.audioWorklet.addModule(
        chrome.runtime.getURL('dist/dsp/noise-remover-processor.js')
      );
      const node = new AudioWorkletNode(ctx, 'noise-remover-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const safety = ctx.createDynamicsCompressor();
      safety.threshold.value = -2.0;
      safety.knee.value = 0.0;
      safety.ratio.value = 20.0;
      safety.attack.value = 0.001;
      safety.release.value = 0.05;
      node.connect(safety);
      safety.connect(ctx.destination);
      state.workletNode = node;
      state.safetyLimiter = safety;
      if (state.profile) {
        node.port.postMessage({
          type: 'UPDATE_CONFIG',
          profile: state.profile,
          temporaryBypass: false,
        });
      }
    })();
    await state.workletReady;
  }

  function routeSource(source: MediaElementAudioSourceNode): void {
    if (!state.ctx || !state.workletNode) return;
    try {
      source.disconnect();
    } catch {
      // not connected yet
    }
    if (state.bypassed) {
      source.connect(state.ctx.destination);
    } else {
      source.connect(state.workletNode);
    }
  }

  async function hookElement(el: HTMLMediaElement): Promise<void> {
    if (state.hooked.has(el)) return;
    state.hooked.add(el);
    try {
      await ensureGraph();
      if (!state.ctx) return;
      // createMediaElementSource may only be called once per element per
      // context; the WeakSet guard above enforces that.
      const source = state.ctx.createMediaElementSource(el);
      state.sources.set(el, source);
      routeSource(source);
      if (state.ctx.state === 'suspended') void state.ctx.resume();
    } catch {
      // Element is cross-origin tainted or already captured by another
      // context — leave its native output alone.
    }
  }

  function hookAllMedia(): void {
    document.querySelectorAll('audio, video').forEach((el) => {
      void hookElement(el as HTMLMediaElement);
    });
  }

  async function applyProfile(profile: NoiseProfile): Promise<void> {
    state.profile = profile;
    state.bypassed = !profile.enabled;
    if (profile.enabled) {
      await ensureGraph();
      hookAllMedia();
      state.workletNode?.port.postMessage({
        type: 'UPDATE_CONFIG',
        profile,
        temporaryBypass: false,
      });
      if (state.ctx?.state === 'suspended') void state.ctx.resume();
    }
    for (const source of state.sources.values()) {
      routeSource(source);
    }
  }

  // New media elements (SPA players) get hooked as they appear / start.
  const observer = new MutationObserver(() => {
    if (state.profile?.enabled) hookAllMedia();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener(
    'play',
    (event) => {
      const el = event.target as HTMLMediaElement;
      if (state.profile?.enabled && el instanceof HTMLMediaElement) {
        void hookElement(el);
      }
    },
    true
  );

  chrome.runtime.onMessage.addListener((msg: { type?: string; profile?: NoiseProfile }) => {
    if (msg?.type === 'FF_UPDATE_DSP' && msg.profile) {
      void applyProfile(msg.profile);
    }
    return false;
  });
}
