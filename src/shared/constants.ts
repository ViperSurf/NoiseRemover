import { NoiseProfile, PresetId } from './types';

export const PRESET_DEFINITIONS: Record<Exclude<PresetId, 'custom'>, Omit<NoiseProfile, 'enabled' | 'monoMerge' | 'calibratedNoiseFloorDb' | 'updatedAt'>> = {
  mic_hiss: {
    preset: 'mic_hiss',
    staticHissCut: 65,
    windFanHumCut: 25,
    cleanVoiceBoost: 115,
  },
  fan_ac: {
    preset: 'fan_ac',
    staticHissCut: 35,
    windFanHumCut: 75,
    cleanVoiceBoost: 110,
  },
  wind_rumble: {
    preset: 'wind_rumble',
    staticHissCut: 20,
    windFanHumCut: 90,
    cleanVoiceBoost: 120,
  },
  voice_focus: {
    preset: 'voice_focus',
    staticHissCut: 75,
    windFanHumCut: 70,
    cleanVoiceBoost: 135,
  },
};

export const DEFAULT_PROFILE: NoiseProfile = {
  enabled: false,
  ...PRESET_DEFINITIONS.mic_hiss,
  monoMerge: false,
  calibratedNoiseFloorDb: -52,
  updatedAt: 0,
};

export const TOOLTIPS: Record<string, string> = {
  masterSwitch: 'Turns real-time noise removal ON or OFF for this tab (Shortcut: Alt+Shift+N). Uses 0% CPU when OFF.',
  holdOriginal: 'Press and hold to temporarily bypass the filter and compare raw vs. cleaned audio.',
  lockControls: 'Freezes sliders and presets against accidental clicks or scroll-wheel changes while keeping the ON/OFF switch active.',
  activeTabsStrip: 'Shows browser tabs currently playing audio. Click any tab pill to adjust its noise filter independently.',
  presetMicHiss: "Removes constant white noise, tape static, and high-pitched microphone hiss while softening harsh 'S' sounds.",
  presetFanAc: 'Cuts steady background motor hum from laptop fans, air conditioners, and room ventilation.',
  presetWindRumble: 'Filters out heavy outdoor wind gusts, breath pops, and deep low-end rumble.',
  presetVoiceFocus: 'Maximizes spoken vocal clarity while suppressing both low hum and high static for lectures, streams, and calls.',
  autoTune: 'Listens to 2 seconds of background noise on this tab and automatically sets the best filter levels without cutting off speech.',
  autoTuneReset: 'Resets sliders and noise calibration back to the default Mic Hiss settings.',
  monoToggle: 'Merges Left and Right audio into both ears. Fixes poorly recorded lectures or videos that only play sound in one ear.',
  sliderStaticHiss: 'Controls how strongly high-frequency white noise, static, and hiss are removed. Double-click to reset.',
  sliderWindFanHum: 'Controls low-frequency filtering for wind gusts, fan drone, and 50/60Hz electrical buzz. Double-click to reset.',
  sliderVoiceBoost: 'Safely amplifies quiet voices after static is removed, with built-in ear protection against sudden loud spikes. Double-click to reset.',
  reductionMeter: 'Live display showing how many decibels (dB) of background static and hum are being removed right now.',
  sitePersistence: 'Your settings are automatically remembered for this website locally on your device. Never sent to the cloud.',
  exportImport: 'Back up your saved website profiles to a local JSON file, or restore from an existing backup.',
  clearAllSites: 'Permanently deletes all saved website noise profiles and restores factory defaults.',
};
