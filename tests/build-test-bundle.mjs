/** Bundles the DSP + storage modules into tests/.tmp/ for the node test runner. */
import * as esbuild from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('tests/.tmp', { recursive: true });

await esbuild.build({
  entryPoints: ['src/dsp/math-biquad.ts'],
  outfile: 'tests/.tmp/math-biquad.mjs',
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'silent',
});
await esbuild.build({
  entryPoints: ['src/shared/storage-store.ts'],
  outfile: 'tests/.tmp/storage-store.mjs',
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'silent',
});
await esbuild.build({
  entryPoints: ['src/dsp/noise-remover-processor.ts'],
  outfile: 'tests/.tmp/processor.js',
  bundle: true, format: 'iife', platform: 'neutral', target: 'es2022', logLevel: 'silent',
});
console.log('test bundles ready');
