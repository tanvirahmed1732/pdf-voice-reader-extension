// Bundles the neural TTS layer into vendor/piper/ (committed, so day-to-day
// development needs no build step). Re-run after upgrading the TTS packages:
// `npm run build:piper`
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'vendor', 'piper');
await mkdir(join(out, 'onnx'), { recursive: true });

await build({
  entryPoints: [join(root, 'scripts', 'piper-src.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome124',
  minify: true,
  outfile: join(out, 'piper-bundle.js'),
  logLevel: 'info',
  // Node builtins referenced only in the Emscripten/ort Node-environment
  // branches, which never execute in the browser.
  external: ['path', 'fs', 'os', 'crypto', 'url', 'util', 'worker_threads', 'perf_hooks', 'module'],
});

// Phonemizer WASM + espeak-ng data (fetched at runtime via locateFile).
const piperWasm = join(root, 'node_modules', '@diffusionstudio', 'piper-wasm', 'build');
for (const f of ['piper_phonemize.wasm', 'piper_phonemize.data']) {
  await copyFile(join(piperWasm, f), join(out, f));
  console.log(`copied ${f}`);
}

// onnxruntime WASM binaries (ort picks the right one; non-threaded is used
// in extension pages, which are not cross-origin isolated).
const ortDist = join(root, 'node_modules', 'onnxruntime-web', 'dist');
for (const f of ['ort-wasm.wasm', 'ort-wasm-simd.wasm', 'ort-wasm-threaded.wasm', 'ort-wasm-simd-threaded.wasm']) {
  await copyFile(join(ortDist, f), join(out, 'onnx', f));
  console.log(`copied onnx/${f}`);
}
