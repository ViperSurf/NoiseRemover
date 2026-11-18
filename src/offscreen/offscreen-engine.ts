import { NoiseProfile } from '../shared/types';

interface TabAudioNodeGraph {
  tabId: number;
  stream: MediaStream;
  audioCtx: AudioContext;
  sourceNode: MediaStreamAudioSourceNode;
  workletNode: AudioWorkletNode;
  safetyLimiter: DynamicsCompressorNode;
  profile: NoiseProfile;
  isBypassed: boolean;
}

const activeGraphs = new Map<number, TabAudioNodeGraph>();
let popupTelemetryPort: chrome.runtime.Port | null = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup-telemetry') {
    popupTelemetryPort = port;
    for (const graph of activeGraphs.values()) {
      graph.workletNode.port.postMessage({ type: 'SET_METER_SUBSCRIPTION', subscribed: true });
    }
    port.onDisconnect.addListener(() => {
      popupTelemetryPort = null;
      for (const graph of activeGraphs.values()) {
        graph.workletNode.port.postMessage({ type: 'SET_METER_SUBSCRIPTION', subscribed: false });
      }
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_INIT_TAB') {
    initTabAudioGraph(msg.tabId, msg.streamId, msg.profile)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg.type === 'OFFSCREEN_UPDATE_DSP') {
    updateTabGraph(msg.tabId, msg.profile, msg.temporaryBypass);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'OFFSCREEN_START_AUTOTUNE') {
    const g = activeGraphs.get(msg.tabId);
    if (g) g.workletNode.port.postMessage({ type: 'START_AUTOTUNE' });
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'OFFSCREEN_RELEASE_TAB') {
    releaseTabGraph(msg.tabId);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

async function initTabAudioGraph(tabId: number, streamId: string, profile: NoiseProfile): Promise<void> {
  releaseTabGraph(tabId);

  // Request AUDIO-ONLY stream so HTML5 <video> fullscreen is never trapped in a windowed box
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    } as unknown as MediaTrackConstraints,
    video: false,
  });

  const audioCtx = new AudioContext({
    sampleRate: 48000,
    latencyHint: 'interactive',
  });

  await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('dist/dsp/noise-remover-processor.js'));

  const sourceNode = audioCtx.createMediaStreamSource(stream);
  const workletNode = new AudioWorkletNode(audioCtx, 'noise-remover-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  // Secondary hardware-level safety compressor (-1 dBFS brickwall backup)
  const safetyLimiter = audioCtx.createDynamicsCompressor();
  safetyLimiter.threshold.value = -2.0;
  safetyLimiter.knee.value = 0.0;
  safetyLimiter.ratio.value = 20.0;
  safetyLimiter.attack.value = 0.001;
  safetyLimiter.release.value = 0.050;

  workletNode.port.onmessage = (event) => {
    const data = event.data;
    if (data.type === 'TELEMETRY_FRAME') {
      // Dynamic graph bypass on >2s silence for 0% CPU overhead
      const graph = activeGraphs.get(tabId);
      if (graph) {
        if (data.idleBypassActive && !graph.isBypassed) {
          engageHardwareBypass(graph, true);
        } else if (!data.idleBypassActive && graph.isBypassed && graph.profile.enabled) {
          engageHardwareBypass(graph, false);
        }
      }
      if (popupTelemetryPort) {
        popupTelemetryPort.postMessage({ ...data, tabId });
      }
    } else if (data.type === 'AUTOTUNE_FINISHED') {
      chrome.runtime.sendMessage({
        type: 'AUTO_TUNE_COMPLETE',
        tabId,
        calibratedProfile: {
          ...profile,
          preset: 'custom',
          staticHissCut: data.staticHissCut,
          windFanHumCut: data.windFanHumCut,
          calibratedNoiseFloorDb: data.calibratedNoiseFloorDb,
          updatedAt: Date.now(),
        },
      });
    }
  };

  workletNode.port.postMessage({
    type: 'UPDATE_CONFIG',
    profile,
    temporaryBypass: false,
  });

  if (popupTelemetryPort) {
    workletNode.port.postMessage({ type: 'SET_METER_SUBSCRIPTION', subscribed: true });
  }

  sourceNode.connect(workletNode);
  workletNode.connect(safetyLimiter);
  safetyLimiter.connect(audioCtx.destination);

  activeGraphs.set(tabId, {
    tabId,
    stream,
    audioCtx,
    sourceNode,
    workletNode,
    safetyLimiter,
    profile,
    isBypassed: false,
  });
}

function engageHardwareBypass(graph: TabAudioNodeGraph, bypass: boolean): void {
  if (graph.isBypassed === bypass) return;
  graph.isBypassed = bypass;
  graph.sourceNode.disconnect();
  if (bypass) {
    // Direct wire from source to destination: 0ms latency, 0% DSP CPU
    graph.sourceNode.connect(graph.audioCtx.destination);
  } else {
    graph.sourceNode.connect(graph.workletNode);
  }
}

function updateTabGraph(tabId: number, profile: NoiseProfile, temporaryBypass?: boolean): void {
  const graph = activeGraphs.get(tabId);
  if (!graph) return;
  graph.profile = profile;

  const shouldBypass = !profile.enabled || Boolean(temporaryBypass);
  engageHardwareBypass(graph, shouldBypass);

  graph.workletNode.port.postMessage({
    type: 'UPDATE_CONFIG',
    profile,
    temporaryBypass: Boolean(temporaryBypass),
  });
}

function releaseTabGraph(tabId: number): void {
  const graph = activeGraphs.get(tabId);
  if (!graph) return;
  try {
    graph.sourceNode.disconnect();
    graph.workletNode.disconnect();
    graph.safetyLimiter.disconnect();
    for (const track of graph.stream.getTracks()) {
      track.stop();
    }
    void graph.audioCtx.close();
  } catch {
    // Ignore cleanup errors on already-closed tracks
  }
  activeGraphs.delete(tabId);
}
