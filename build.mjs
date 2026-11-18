/**
 * Zero-runtime-dependency bundler.
 *
 * Builds two unpacked extension directories:
 *   build/chrome/   — Chromium MV3 (tabCapture + offscreen)
 *   build/firefox/  — Firefox MV3 (activeTab injection, no tabCapture)
 *
 * Each target is a self-contained extension root: manifest.json at the top,
 * compiled code under dist/, icons under assets/. The AudioWorklet processor
 * is bundled as a standalone IIFE (worklets cannot use ES module imports in
 * every browser); everything else ships as ES modules.
 */
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const TARGETS = ['chrome', 'firefox'];

const MODULE_ENTRIES = [
  { in: 'src/background/audio-router.ts', out: 'background/audio-router' },
  { in: 'src/offscreen/offscreen-engine.ts', out: 'offscreen/offscreen-engine' },
  { in: 'src/popup/popup.ts', out: 'popup/popup' },
];

async function buildTarget(target) {
  const root = `build/${target}`;
  const dist = `${root}/dist`;
  await mkdir(dist, { recursive: true });

  // ES-module entry points
  await esbuild.build({
    entryPoints: MODULE_ENTRIES.map((e) => e.in),
    outdir: dist,
    outbase: 'src',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: false,
    logLevel: 'silent',
  });

  // AudioWorklet processor: standalone IIFE, no imports at runtime
  await esbuild.build({
    entryPoints: ['src/dsp/noise-remover-processor.ts'],
    outfile: `${dist}/dsp/noise-remover-processor.js`,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: false,
    logLevel: 'silent',
  });

  // Firefox page injector: classic content script (IIFE)
  if (target === 'firefox') {
    await esbuild.build({
      entryPoints: ['src/content/firefox-audio-injector.ts'],
      outfile: `${dist}/content/firefox-audio-injector.js`,
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      sourcemap: false,
      logLevel: 'silent',
    });
  }

  // Static files
  await cp('src/popup/popup.html', `${dist}/popup/popup.html`);
  await cp('src/popup/popup.css', `${dist}/popup/popup.css`);
  await cp('src/offscreen/offscreen.html', `${dist}/offscreen/offscreen.html`);
  await cp('assets', `${root}/assets`, { recursive: true });

  // Manifest — verified air-gapped before it ships
  const manifest = JSON.parse(await readFile(`manifests/${target}/manifest.json`, 'utf8'));
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  if (!csp.includes("connect-src 'none'")) {
    throw new Error(`${target} manifest is not air-gapped: connect-src 'none' missing`);
  }
  await writeFile(`${root}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✓ build/${target}/ (manifest CSP verified: connect-src 'none')`);
}

await rm('build', { recursive: true, force: true });
for (const target of TARGETS) {
  await buildTarget(target);
}
if (!existsSync('build/chrome/manifest.json') || !existsSync('build/firefox/manifest.json')) {
  throw new Error('build incomplete: a target manifest is missing');
}
console.log('Build complete: build/chrome/ and build/firefox/ are ready to load unpacked.');
