export type PresetId = 'mic_hiss' | 'fan_ac' | 'wind_rumble' | 'voice_focus' | 'custom';

export interface NoiseProfile {
  enabled: boolean;
  preset: PresetId;
  /** 0 to 100 (%) - High-frequency white noise, static, and hiss suppression + de-esser */
  staticHissCut: number;
  /** 0 to 100 (%) - Low-frequency wind HPF (20-180Hz), 50/60Hz notch + 100/120Hz harmonics, fan expander (120-350Hz) */
  windFanHumCut: number;
  /** 100 to 250 (%) - Post-cleanup voice makeup gain before -1 dBFS brickwall limiter */
  cleanVoiceBoost: number;
  /** Sums L+R to mono (0.5 * (L + R)) to fix single-ear lectures/recordings */
  monoMerge: boolean;
  /** Auto-tuned noise floor offsets in dBFS (populated by 2s Auto-Tune, 0 by default) */
  calibratedNoiseFloorDb: number;
  updatedAt: number;
}

export interface SiteProfileMap {
  [domain: string]: NoiseProfile;
}

export interface GlobalExtensionSettings {
  version: 1;
  controlsLocked: boolean;
  defaultProfile: NoiseProfile;
  siteProfiles: SiteProfileMap;
}

export interface ActiveTabAudioInfo {
  tabId: number;
  domain: string;
  title: string;
  audible: boolean;
  capturing: boolean;
  isSilentBypassed: boolean;
  profile: NoiseProfile;
}

export interface DspTelemetryFrame {
  tabId: number;
  /** Input RMS in dBFS (-100 to 0) */
  inputRmsDb: number;
  /** Output RMS in dBFS (-100 to 0) */
  outputRmsDb: number;
  /** Instantaneous noise attenuation in dB (0 to 40) */
  attenuationDb: number;
  /** True if tab has been silent (< -65 dBFS) for > 2000ms and DSP is bypassed */
  idleBypassActive: boolean;
  /** Auto-Tune progress (0 to 1, or null if not running) */
  autoTuneProgress: number | null;
}

export type IpcMessage =
  | { type: 'GET_POPUP_STATE'; activeTabId: number }
  | { type: 'UPDATE_TAB_PROFILE'; tabId: number; domain: string; profile: Partial<NoiseProfile>; saveToSite: boolean }
  | { type: 'TOGGLE_HOLD_BYPASS'; tabId: number; bypass: boolean }
  | { type: 'START_AUTO_TUNE'; tabId: number }
  | { type: 'AUTO_TUNE_COMPLETE'; tabId: number; calibratedProfile: NoiseProfile }
  | { type: 'SET_CONTROLS_LOCKED'; locked: boolean }
  | { type: 'RESET_SITE_PROFILE'; tabId: number; domain: string }
  | { type: 'CLEAR_ALL_PROFILES' }
  | { type: 'IMPORT_SETTINGS_JSON'; payload: GlobalExtensionSettings }
  | { type: 'OFFSCREEN_INIT_TAB'; tabId: number; streamId: string; profile: NoiseProfile }
  | { type: 'OFFSCREEN_UPDATE_DSP'; tabId: number; profile: NoiseProfile; temporaryBypass?: boolean }
  | { type: 'OFFSCREEN_RELEASE_TAB'; tabId: number }
  | { type: 'OFFSCREEN_START_AUTOTUNE'; tabId: number };
