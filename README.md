# Static, Hiss, Wind & Fan Noise Remover

A cross-browser extension that cleans up **tab audio in real time** — static,
microphone hiss, fan/AC drone, wind rumble and 50/60 Hz hum — with a
zero-allocation `AudioWorklet` DSP chain running at 48 kHz. Everything is
**100% local**: no network requests, no accounts, no analytics. Both manifests
ship with `connect-src 'none'`, so the extension *cannot* phone home.

## What it does

- **One master switch per tab** (`Alt+Shift+N`), with an `ON` badge, plus a
  per-tab strip so a lecture tab and a music tab keep independent settings.
- **4 one-click presets** — Mic Hiss, Fan & AC, Wind & Rumble, Voice Focus —
  and 3 precision sliders: Static & Hiss Cut, Wind/Fan/Hum Cut, Clean Voice
  Boost (100–250%, behind a −1 dBFS brickwall limiter so boosts never blast
  your ears).
- **Auto-Tune (2s)** listens to the tab's background noise and sets the
  filters and calibrated noise floor for you.
- **Hold: Hear Original** — press and hold to A/B the raw audio against the
  cleaned audio.
- **Mono (Both Ears)** fixes lectures/videos recorded in a single channel.
- **Live reduction meter** showing dB of noise being removed right now,
  rendered at 60 fps from ~30 Hz telemetry (the DSP never floods the UI bus).
- **Per-site memory** — settings are remembered per website in
  `chrome.storage.local`, on your device only. Export/import your profiles
  as a local JSON file; two-tier confirmations with a 5-second undo protect
  destructive actions, and a padlock freezes the controls against accidents.
- **0% CPU when idle** — after 2 seconds of silence the DSP bypasses and the
  Chromium graph is hard-disconnected; when the filter is OFF the tab capture
  is fully released (which also keeps HTML5 fullscreen video working).

## DSP chain (inside the AudioWorklet, per 128-frame quantum)

1. Silence watchdog & bypass gate
2. Optional mono merge
3. Wind/rumble/hum conditioner — variable 20–180 Hz high-pass + 50/60/100/120 Hz notch bank
4. Multi-band hysteresis expander (fan drone 120–350 Hz, hiss 3.8–14 kHz; 6 dB hysteresis, 150 ms hold — no speech chopping)
5. Dynamic de-esser around 7.2 kHz
6. Clean voice boost + soft-knee brickwall limiter at −1.0 dBFS

All filter state is pre-allocated and mutated in place — no allocations on
the real-time audio thread.

## Browsers

| Browser | Capture strategy |
| --- | --- |
| Chrome / Edge / Brave / Opera | `tabCapture` → single offscreen document hosting one audio graph per tab |
| Firefox | `activeTab` injection hooking the page's media elements into the same worklet graph (Firefox has no `tabCapture`) |

Permissions are minimal by design: `activeTab`, `storage`, and (Chromium
only) `tabCapture` + `offscreen`; Firefox adds `scripting` for the injection.
No `<all_urls>` host access, no history, no web requests.

## Install (unpacked)

```bash
npm install     # dev tooling only — the extension itself has zero runtime dependencies
npm run build   # produces build/chrome/ and build/firefox/
```

- **Chromium:** `chrome://extensions` → enable Developer mode → *Load
  unpacked* → select `build/chrome/`.
- **Firefox:** `about:debugging` → *This Firefox* → *Load Temporary
  Add-on* → select `build/firefox/manifest.json`.

## Develop

```bash
npm run typecheck   # tsc --noEmit
npm test            # headless DSP verification (biquad math, limiter ceiling,
                    # hum attenuation, silence bypass, schema validation)
npm run build
```

## Layout

```text
manifests/            chrome/ + firefox/ MV3 manifests (air-gapped CSP)
src/shared/           types, presets/tooltips, validated storage store
src/dsp/              biquad coefficient engine + AudioWorklet processor
src/offscreen/        Chromium multi-tab audio graph engine
src/background/       service-worker router: capture, badges, hotkey, IPC
src/content/          Firefox media-element injector
src/popup/            330px single-screen UI + 60fps canvas meter
tests/                headless DSP tests (node:test)
build.mjs             esbuild bundler for both targets
```

## Privacy

No servers, no telemetry, no third-party anything. Settings never leave the
browser's local storage. The `connect-src 'none'` content security policy is
verified at build time — the build fails if a manifest ever loses it.
