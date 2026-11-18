import { DEFAULT_PROFILE } from './constants';
import { GlobalExtensionSettings, NoiseProfile } from './types';

export const STORAGE_KEY = 'noise_remover_settings_v1';
export const SESSION_KEY = 'noise_remover_session_v1';

/** Runtime state mirrored into chrome.storage.session so MV3 service-worker
 *  restarts (30s idle termination) never lose the active-tab / undo picture. */
export interface SessionState {
  activeTabs: number[];
  controlsLocked: boolean;
}

const PRESET_IDS = ['mic_hiss', 'fan_ac', 'wind_rumble', 'voice_focus', 'custom'];

export function validateProfile(raw: unknown): NoiseProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.enabled !== 'boolean') return null;
  if (typeof p.preset !== 'string' || !PRESET_IDS.includes(p.preset)) return null;
  if (typeof p.staticHissCut !== 'number' || p.staticHissCut < 0 || p.staticHissCut > 100) return null;
  if (typeof p.windFanHumCut !== 'number' || p.windFanHumCut < 0 || p.windFanHumCut > 100) return null;
  if (typeof p.cleanVoiceBoost !== 'number' || p.cleanVoiceBoost < 100 || p.cleanVoiceBoost > 250) return null;
  if (typeof p.monoMerge !== 'boolean') return null;
  if (typeof p.calibratedNoiseFloorDb !== 'number') return null;
  return raw as NoiseProfile;
}

export function validateSettings(raw: unknown): GlobalExtensionSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (s.version !== 1) return null;
  if (typeof s.controlsLocked !== 'boolean') return null;
  if (!validateProfile(s.defaultProfile)) return null;
  if (!s.siteProfiles || typeof s.siteProfiles !== 'object') return null;
  for (const profile of Object.values(s.siteProfiles as Record<string, unknown>)) {
    if (!validateProfile(profile)) return null;
  }
  return raw as GlobalExtensionSettings;
}

export function defaultSettings(): GlobalExtensionSettings {
  return {
    version: 1,
    controlsLocked: false,
    defaultProfile: { ...DEFAULT_PROFILE },
    siteProfiles: {},
  };
}

export async function loadSettings(): Promise<GlobalExtensionSettings> {
  const res = await chrome.storage.local.get(STORAGE_KEY);
  const stored = validateSettings(res[STORAGE_KEY]);
  if (stored) return stored;
  const initial = defaultSettings();
  await chrome.storage.local.set({ [STORAGE_KEY]: initial });
  return initial;
}

export async function saveSettings(settings: GlobalExtensionSettings): Promise<void> {
  if (!validateSettings(settings)) {
    throw new Error('Refusing to persist invalid settings schema');
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

export async function loadSessionState(): Promise<SessionState> {
  try {
    const res = await chrome.storage.session.get(SESSION_KEY);
    const s = res[SESSION_KEY] as SessionState | undefined;
    if (s && Array.isArray(s.activeTabs)) return s;
  } catch {
    // chrome.storage.session unavailable (older Firefox) — fall back to empty.
  }
  return { activeTabs: [], controlsLocked: false };
}

export async function saveSessionState(state: SessionState): Promise<void> {
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: state });
  } catch {
    // Non-fatal: session mirroring is a restart-resilience aid, not a requirement.
  }
}
