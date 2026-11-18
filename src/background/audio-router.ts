import { DEFAULT_PROFILE } from '../shared/constants';
import { loadSettings, saveSettings } from '../shared/storage-store';
import {
  ActiveTabAudioInfo,
  GlobalExtensionSettings,
  NoiseProfile,
} from '../shared/types';

const capturedTabs = new Set<number>();
const IS_FIREFOX = typeof chrome.tabCapture === 'undefined';

function extractDomain(url?: string): string {
  if (!url) return 'local-tab';
  try {
    const parsed = new URL(url);
    return parsed.hostname || 'local-tab';
  } catch {
    return 'local-tab';
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  if (IS_FIREFOX) return;
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'dist/offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Real-time <10ms Web Audio API noise removal on captured tab audio',
  });
}

async function applyTabProfile(tabId: number, domain: string, profile: NoiseProfile): Promise<void> {
  if (!profile.enabled) {
    if (capturedTabs.has(tabId)) {
      if (IS_FIREFOX) {
        await chrome.tabs.sendMessage(tabId, { type: 'FF_UPDATE_DSP', profile });
      } else {
        // Release capture completely when switched OFF so fullscreen video & zero-CPU are guaranteed
        await chrome.runtime.sendMessage({ type: 'OFFSCREEN_RELEASE_TAB', tabId });
      }
      capturedTabs.delete(tabId);
    }
    await updateBadge(tabId, false);
    return;
  }

  if (IS_FIREFOX) {
    if (!capturedTabs.has(tabId)) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['dist/content/firefox-audio-injector.js'],
      });
      capturedTabs.add(tabId);
    }
    await chrome.tabs.sendMessage(tabId, { type: 'FF_UPDATE_DSP', profile });
  } else {
    await ensureOffscreenDocument();
    if (!capturedTabs.has(tabId)) {
      const streamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          if (chrome.runtime.lastError || !id) {
            reject(new Error(chrome.runtime.lastError?.message ?? 'Failed to get streamId'));
          } else {
            resolve(id);
          }
        });
      });
      await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_INIT_TAB',
        tabId,
        streamId,
        profile,
      });
      capturedTabs.add(tabId);
    } else {
      await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_UPDATE_DSP',
        tabId,
        profile,
        temporaryBypass: false,
      });
    }
  }

  await updateBadge(tabId, true);
}

async function updateBadge(tabId: number, enabled: boolean): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text: enabled ? 'ON' : '' });
  if (enabled) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#10B981' });
  }
}

// Global Hotkey: Alt+Shift+N
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-noise-filter') return;
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) return;

  const settings = await loadSettings();
  const domain = extractDomain(activeTab.url);
  const existing = settings.siteProfiles[domain] ?? { ...settings.defaultProfile };
  const updated: NoiseProfile = {
    ...existing,
    enabled: !existing.enabled,
    updatedAt: Date.now(),
  };

  settings.siteProfiles[domain] = updated;
  await saveSettings(settings);
  await applyTabProfile(activeTab.id, domain, updated);
});

// Clean up when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (capturedTabs.has(tabId)) {
    capturedTabs.delete(tabId);
    if (!IS_FIREFOX) {
      void chrome.runtime.sendMessage({ type: 'OFFSCREEN_RELEASE_TAB', tabId });
    }
  }
});

// IPC Coordinator for Popup & Offscreen
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const settings = await loadSettings();

    if (msg.type === 'GET_POPUP_STATE') {
      const allTabs = await chrome.tabs.query({ currentWindow: true });
      const activeAudioTabs: ActiveTabAudioInfo[] = [];

      for (const t of allTabs) {
        if (!t.id) continue;
        const isTarget = t.id === msg.activeTabId || Boolean(t.audible) || capturedTabs.has(t.id);
        if (!isTarget) continue;

        const domain = extractDomain(t.url);
        const baseProfile = settings.siteProfiles[domain] ?? { ...settings.defaultProfile };
        activeAudioTabs.push({
          tabId: t.id,
          domain,
          title: t.title || domain,
          audible: Boolean(t.audible),
          capturing: capturedTabs.has(t.id),
          isSilentBypassed: false,
          profile: {
            ...baseProfile,
            enabled: capturedTabs.has(t.id) ? baseProfile.enabled : false,
          },
        });
      }

      sendResponse({
        controlsLocked: settings.controlsLocked,
        tabs: activeAudioTabs,
        allSettings: settings,
      });
      return;
    }

    if (msg.type === 'UPDATE_TAB_PROFILE') {
      const { tabId, domain, profile, saveToSite } = msg;
      const current = settings.siteProfiles[domain] ?? { ...settings.defaultProfile };
      const merged: NoiseProfile = { ...current, ...profile, updatedAt: Date.now() };

      if (saveToSite && domain !== 'local-tab') {
        settings.siteProfiles[domain] = merged;
        await saveSettings(settings);
      }
      await applyTabProfile(tabId, domain, merged);
      sendResponse({ ok: true, profile: merged });
      return;
    }

    if (msg.type === 'TOGGLE_HOLD_BYPASS') {
      const { tabId, bypass } = msg;
      const tab = await chrome.tabs.get(tabId);
      const domain = extractDomain(tab.url);
      const current = settings.siteProfiles[domain] ?? { ...settings.defaultProfile };
      if (!IS_FIREFOX && capturedTabs.has(tabId)) {
        await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_UPDATE_DSP',
          tabId,
          profile: current,
          temporaryBypass: bypass,
        });
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'START_AUTO_TUNE') {
      const { tabId } = msg;
      if (!IS_FIREFOX && capturedTabs.has(tabId)) {
        await chrome.runtime.sendMessage({ type: 'OFFSCREEN_START_AUTOTUNE', tabId });
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'AUTO_TUNE_COMPLETE') {
      const { tabId, calibratedProfile } = msg;
      const tab = await chrome.tabs.get(tabId);
      const domain = extractDomain(tab.url);
      settings.siteProfiles[domain] = calibratedProfile;
      await saveSettings(settings);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'SET_CONTROLS_LOCKED') {
      settings.controlsLocked = Boolean(msg.locked);
      await saveSettings(settings);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'RESET_SITE_PROFILE') {
      const { tabId, domain } = msg;
      const previous = settings.siteProfiles[domain];
      delete settings.siteProfiles[domain];
      await saveSettings(settings);
      const fallback: NoiseProfile = { ... DEFAULT_PROFILE, enabled: capturedTabs.has(tabId) };
      await applyTabProfile(tabId, domain, fallback);
      sendResponse({ ok: true, previousProfile: previous, currentProfile: fallback });
      return;
    }

    if (msg.type === 'CLEAR_ALL_PROFILES') {
      settings.siteProfiles = {};
      await saveSettings(settings);
      for (const tabId of Array.from(capturedTabs)) {
        await applyTabProfile(tabId, 'local-tab', { ...DEFAULT_PROFILE, enabled: false });
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'IMPORT_SETTINGS_JSON') {
      const payload = msg.payload as GlobalExtensionSettings;
      if (payload && payload.version === 1 && typeof payload.siteProfiles === 'object') {
        await saveSettings(payload);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'Invalid settings schema' });
      }
      return;
    }
  })();
  return true;
});
