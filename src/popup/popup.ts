import { DEFAULT_PROFILE, PRESET_DEFINITIONS, TOOLTIPS } from '../shared/constants';
import { ActiveTabAudioInfo, DspTelemetryFrame, GlobalExtensionSettings, NoiseProfile, PresetId } from '../shared/types';
import { ReductionMeter } from './canvas-meter';

let selectedTabId = 0;
let selectedDomain = 'local-tab';
let currentProfile: NoiseProfile = { ...DEFAULT_PROFILE };
let controlsLocked = false;
let undoTimerId: number | null = null;

// 60fps Canvas Meter state (rendering/interpolation lives in canvas-meter.ts)
const reductionMeter = new ReductionMeter();
let isIdleBypassed = false;
let autoTuneProgress: number | null = null;

document.addEventListener('DOMContentLoaded', async () => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  selectedTabId = activeTab?.id ?? 0;

  initTooltips();
  initControls();
  initTelemetryStream();
  await refreshPopupState();
  requestAnimationFrame(renderMeterLoop);
});

async function refreshPopupState(): Promise<void> {
  const res = await chrome.runtime.sendMessage({
    type: 'GET_POPUP_STATE',
    activeTabId: selectedTabId,
  });
  if (!res) return;

  controlsLocked = Boolean(res.controlsLocked);
  const tabs: ActiveTabAudioInfo[] = res.tabs || [];
  const activeEntry = tabs.find((t) => t.tabId === selectedTabId) ?? tabs[0];

  if (activeEntry) {
    selectedTabId = activeEntry.tabId;
    selectedDomain = activeEntry.domain;
    currentProfile = { ...activeEntry.profile };
  }

  renderTabsStrip(tabs);
  syncUiToProfile(currentProfile, controlsLocked);
}

function renderTabsStrip(tabs: ActiveTabAudioInfo[]): void {
  const container = document.getElementById('activeTabsContainer')!;
  container.innerHTML = '';

  for (const t of tabs) {
    const btn = document.createElement('button');
    btn.className = `tab-pill ${t.tabId === selectedTabId ? 'active' : ''}`;
    const statusPrefix = t.profile.enabled ? '🟢 ' : t.audible ? '🔊 ' : '';
    btn.textContent = `${statusPrefix}${t.domain}`;
    btn.addEventListener('click', () => {
      selectedTabId = t.tabId;
      selectedDomain = t.domain;
      currentProfile = { ...t.profile };
      renderTabsStrip(tabs);
      syncUiToProfile(currentProfile, controlsLocked);
    });
    container.appendChild(btn);
  }
}

function syncUiToProfile(p: NoiseProfile, locked: boolean): void {
  const masterBtn = document.getElementById('masterToggleBtn')!;
  const masterLabel = document.getElementById('masterToggleLabel')!;
  const holdBtn = document.getElementById('holdBypassBtn') as HTMLButtonElement;
  const lockBtn = document.getElementById('lockControlsBtn')!;
  const lockIcon = document.getElementById('lockIcon')!;
  const lockableArea = document.getElementById('lockableArea')!;

  masterBtn.setAttribute('aria-checked', String(p.enabled));
  masterLabel.textContent = `Noise Filter: ${p.enabled ? 'ON' : 'OFF'}`;
  holdBtn.disabled = !p.enabled;

  lockBtn.setAttribute('aria-pressed', String(locked));
  lockIcon.textContent = locked ? '🔒' : '🔓';
  lockableArea.classList.toggle('locked', locked);

  document.querySelectorAll<HTMLButtonElement>('.preset-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.preset === p.preset);
  });

  const monoBtn = document.getElementById('monoToggleBtn')!;
  monoBtn.setAttribute('aria-pressed', String(p.monoMerge));

  const sHiss = document.getElementById('sliderStaticHiss') as HTMLInputElement;
  const sWind = document.getElementById('sliderWindFanHum') as HTMLInputElement;
  const sBoost = document.getElementById('sliderVoiceBoost') as HTMLInputElement;

  sHiss.value = String(p.staticHissCut);
  sWind.value = String(p.windFanHumCut);
  sBoost.value = String(p.cleanVoiceBoost);

  document.getElementById('valStaticHiss')!.textContent = `${p.staticHissCut}%`;
  document.getElementById('valWindFanHum')!.textContent = `${p.windFanHumCut}%`;
  document.getElementById('valVoiceBoost')!.textContent = `${p.cleanVoiceBoost}%`;
  document.getElementById('siteSavedText')!.textContent = `Saved for ${selectedDomain}`;
}

async function pushProfileUpdate(patch: Partial<NoiseProfile>, undoLabel?: string): Promise<void> {
  const previousSnapshot: NoiseProfile = { ...currentProfile };
  currentProfile = { ...currentProfile, ...patch, updatedAt: Date.now() };
  syncUiToProfile(currentProfile, controlsLocked);

  await chrome.runtime.sendMessage({
    type: 'UPDATE_TAB_PROFILE',
    tabId: selectedTabId,
    domain: selectedDomain,
    profile: currentProfile,
    saveToSite: true,
  });

  if (undoLabel) {
    showTier1UndoBar(undoLabel, async () => {
      currentProfile = previousSnapshot;
      syncUiToProfile(currentProfile, controlsLocked);
      await chrome.runtime.sendMessage({
        type: 'UPDATE_TAB_PROFILE',
        tabId: selectedTabId,
        domain: selectedDomain,
        profile: currentProfile,
        saveToSite: true,
      });
    });
  }
}

function initControls(): void {
  // Master ON/OFF Toggle
  document.getElementById('masterToggleBtn')!.addEventListener('click', () => {
    void pushProfileUpdate({ enabled: !currentProfile.enabled });
  });

  // Momentary Hold: Hear Original A/B Button
  const holdBtn = document.getElementById('holdBypassBtn')!;
  const setHold = (bypass: boolean) => {
    void chrome.runtime.sendMessage({ type: 'TOGGLE_HOLD_BYPASS', tabId: selectedTabId, bypass });
  };
  holdBtn.addEventListener('pointerdown', () => setHold(true));
  holdBtn.addEventListener('pointerup', () => setHold(false));
  holdBtn.addEventListener('pointerleave', () => setHold(false));

  // Padlock Controls Lock
  document.getElementById('lockControlsBtn')!.addEventListener('click', async () => {
    controlsLocked = !controlsLocked;
    syncUiToProfile(currentProfile, controlsLocked);
    await chrome.runtime.sendMessage({ type: 'SET_CONTROLS_LOCKED', locked: controlsLocked });
  });

  // 4 One-Click Presets
  document.querySelectorAll<HTMLButtonElement>('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (controlsLocked) return;
      const presetKey = btn.dataset.preset as Exclude<PresetId, 'custom'>;
      const presetValues = PRESET_DEFINITIONS[presetKey];
      void pushProfileUpdate({ ...presetValues, enabled: true }, `Preset: ${btn.textContent}`);
    });
  });

  // Auto-Tune (2s) & Reset
  document.getElementById('autoTuneBtn')!.addEventListener('click', async () => {
    if (controlsLocked) return;
    if (!currentProfile.enabled) {
      await pushProfileUpdate({ enabled: true });
    }
    await chrome.runtime.sendMessage({ type: 'START_AUTO_TUNE', tabId: selectedTabId });
  });

  document.getElementById('resetDefaultBtn')!.addEventListener('click', () => {
    if (controlsLocked) return;
    void pushProfileUpdate(
      { ...PRESET_DEFINITIONS.mic_hiss, calibratedNoiseFloorDb: -52 },
      'Reset to default'
    );
  });

  // Mono Toggle
  document.getElementById('monoToggleBtn')!.addEventListener('click', () => {
    if (controlsLocked) return;
    void pushProfileUpdate(
      { monoMerge: !currentProfile.monoMerge },
      `Mono: ${!currentProfile.monoMerge ? 'ON' : 'OFF'}`
    );
  });

  // 3 Sliders + Double-Click to Reset Individual Slider
  bindSlider('sliderStaticHiss', 'staticHissCut');
  bindSlider('sliderWindFanHum', 'windFanHumCut');
  bindSlider('sliderVoiceBoost', 'cleanVoiceBoost');

  // Tier 1: Single Site Reset with 5s Undo
  document.getElementById('resetSiteBtn')!.addEventListener('click', async () => {
    const snap = { ...currentProfile };
    const res = await chrome.runtime.sendMessage({
      type: 'RESET_SITE_PROFILE',
      tabId: selectedTabId,
      domain: selectedDomain,
    });
    if (res?.currentProfile) {
      currentProfile = res.currentProfile;
      syncUiToProfile(currentProfile, controlsLocked);
      showTier1UndoBar(`Reset ${selectedDomain}`, async () => {
        await pushProfileUpdate(snap);
      });
    }
  });

  // Tier 2: Clear All Saved Sites (Single Inline Confirmation Strip)
  document.getElementById('clearAllSitesBtn')!.addEventListener('click', () => {
    showTier2InlineConfirm('Delete all saved website profiles?', 'Confirm Delete', async () => {
      await chrome.runtime.sendMessage({ type: 'CLEAR_ALL_PROFILES' });
      await refreshPopupState();
    });
  });

  // Export & Import JSON (Tier 2 inline confirmation on overwrite)
  document.getElementById('exportBtn')!.addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'GET_POPUP_STATE', activeTabId: selectedTabId });
    const blob = new Blob([JSON.stringify(res.allSettings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'noise-remover-profiles.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  const fileInput = document.getElementById('importFileInput') as HTMLInputElement;
  document.getElementById('importBtn')!.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const parsed = JSON.parse(text) as GlobalExtensionSettings;
      showTier2InlineConfirm('Overwrite saved profiles with imported file?', 'Overwrite', async () => {
        await chrome.runtime.sendMessage({ type: 'IMPORT_SETTINGS_JSON', payload: parsed });
        await refreshPopupState();
      });
    } catch {
      showTier1UndoBar('Invalid JSON backup file.', () => {});
    }
    fileInput.value = '';
  });
}

function bindSlider(elementId: string, key: 'staticHissCut' | 'windFanHumCut' | 'cleanVoiceBoost'): void {
  const input = document.getElementById(elementId) as HTMLInputElement;
  input.addEventListener('input', () => {
    if (controlsLocked) return;
    const val = Number(input.value);
    const patch: Partial<NoiseProfile> = { [key]: val };
    if (key !== 'cleanVoiceBoost') patch.preset = 'custom';
    void pushProfileUpdate(patch);
  });

  input.addEventListener('dblclick', () => {
    if (controlsLocked) return;
    const defaultVal = Number(input.dataset.default || 0);
    void pushProfileUpdate({ [key]: defaultVal }, 'Slider reset');
  });
}

// Two-Tier Smart Confirmations
function showTier1UndoBar(message: string, onUndo: () => void | Promise<void>): void {
  if (undoTimerId) clearTimeout(undoTimerId);
  const bar = document.getElementById('inlineFeedbackBar')!;
  const msgEl = document.getElementById('feedbackMessage')!;
  const priBtn = document.getElementById('feedbackPrimaryBtn')!;
  const canBtn = document.getElementById('feedbackCancelBtn')!;

  msgEl.textContent = message;
  priBtn.textContent = 'Undo (5s)';
  canBtn.classList.add('hidden');
  bar.classList.remove('hidden');

  priBtn.onclick = async () => {
    if (undoTimerId) clearTimeout(undoTimerId);
    bar.classList.add('hidden');
    await onUndo();
  };

  undoTimerId = window.setTimeout(() => {
    bar.classList.add('hidden');
  }, 5000);
}

function showTier2InlineConfirm(promptText: string, confirmLabel: string, onConfirm: () => Promise<void>): void {
  if (undoTimerId) clearTimeout(undoTimerId);
  const bar = document.getElementById('inlineFeedbackBar')!;
  const msgEl = document.getElementById('feedbackMessage')!;
  const priBtn = document.getElementById('feedbackPrimaryBtn')!;
  const canBtn = document.getElementById('feedbackCancelBtn')!;

  msgEl.textContent = promptText;
  priBtn.textContent = confirmLabel;
  canBtn.classList.remove('hidden');
  bar.classList.remove('hidden');

  priBtn.onclick = async () => {
    bar.classList.add('hidden');
    await onConfirm();
  };
  canBtn.onclick = () => {
    bar.classList.add('hidden');
  };
}

// Universal (?) Tooltip Controller
function initTooltips(): void {
  const popover = document.getElementById('tooltipPopover')!;
  const triggers = document.querySelectorAll<HTMLElement>('.tooltip-trigger');

  const show = (el: HTMLElement) => {
    const key = el.dataset.tooltip;
    if (!key || !TOOLTIPS[key]) return;
    popover.textContent = TOOLTIPS[key];
    popover.classList.remove('hidden');
  };
  const hide = () => popover.classList.add('hidden');

  triggers.forEach((el) => {
    el.addEventListener('mouseenter', () => show(el));
    el.addEventListener('mouseleave', hide);
    el.addEventListener('focus', () => show(el));
    el.addEventListener('blur', hide);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      show(el);
    });
  });
}

// Live 60fps <canvas> Meter
function initTelemetryStream(): void {
  const port = chrome.runtime.connect({ name: 'popup-telemetry' });
  port.onMessage.addListener((frame: DspTelemetryFrame) => {
    if (frame.tabId !== selectedTabId) return;
    reductionMeter.setTarget(frame.attenuationDb);
    isIdleBypassed = frame.idleBypassActive;
    autoTuneProgress = frame.autoTuneProgress;
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'AUTO_TUNE_COMPLETE' && msg.tabId === selectedTabId) {
      autoTuneProgress = null;
      const snap = { ...currentProfile };
      currentProfile = msg.calibratedProfile;
      syncUiToProfile(currentProfile, controlsLocked);
      showTier1UndoBar('Auto-Tune (2s) complete', async () => {
        await pushProfileUpdate(snap);
      });
    }
  });
}

function renderMeterLoop(): void {
  const canvas = document.getElementById('reductionCanvas') as HTMLCanvasElement;
  const statusEl = document.getElementById('meterStatusText')!;
  if (canvas && statusEl) {
    reductionMeter.render(canvas, statusEl, {
      enabled: currentProfile.enabled,
      idleBypassed: isIdleBypassed,
      autoTuneProgress,
    });
  }
  requestAnimationFrame(renderMeterLoop);
}
