// Source for vendor/piper/piper-bundle.js (built by scripts/build-piper.mjs).
//
// Re-exports the piper-tts-web voice-management helpers (OPFS download cache)
// and adds PiperSession — a custom synthesis layer that, unlike the package's
// TtsSession, exposes the length-scale (speaking rate), supports switching
// voices, and returns raw PCM for direct Web Audio playback.

import { PATH_MAP, HF_BASE, remove, stored } from '@mintplex-labs/piper-tts-web';
import { createPiperPhonemize } from '../node_modules/@mintplex-labs/piper-tts-web/dist/piper-o91UDS6e.js';
import * as ort from 'onnxruntime-web';

export { PATH_MAP, HF_BASE, remove, stored };

const OPFS_DIR = 'piper';

async function opfsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

async function opfsFile(name) {
  const dir = await opfsDir();
  const handle = await dir.getFileHandle(name);
  return handle.getFile();
}

async function writeOpfs(name, blob) {
  const dir = await opfsDir();
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

// Own implementation instead of the package's download(): that one doesn't
// await its OPFS write, so the model can be read back truncated, and it
// never checks res.ok. Progress shape matches the package: {url, total, loaded}.
export async function download(voiceId, onProgress) {
  const path = PATH_MAP[voiceId];
  if (!path) throw new Error(`Unknown voice: ${voiceId}`);
  const files = [
    { url: `${HF_BASE}/${path}.json`, name: `${voiceId}.onnx.json`, report: false },
    { url: `${HF_BASE}/${path}`, name: `${voiceId}.onnx`, report: true },
  ];
  for (const file of files) {
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`Voice download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get('Content-Length')) || 0;
    if (!file.report || !res.body) {
      await writeOpfs(file.name, await res.blob());
      continue;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress?.({ url: file.url, total, loaded });
    }
    await writeOpfs(file.name, new Blob(chunks));
  }
}

export async function ensureVoiceDownloaded(voiceId, onProgress) {
  const have = await stored();
  if (!have.includes(voiceId)) {
    await download(voiceId, (p) => onProgress?.(p.total ? p.loaded / p.total : 0));
  }
}

// The phonemizer wasm + espeak data (17 MB) are fetched once and reused for
// every sentence — recreating them per call costs 100ms+ of fetch/unpack each.
let phonemizeAssets = null;
async function loadPhonemizeAssets(wasmRoot) {
  if (!phonemizeAssets) {
    phonemizeAssets = Promise.all([
      fetch(`${wasmRoot}piper_phonemize.wasm`).then((r) => r.arrayBuffer()),
      fetch(`${wasmRoot}piper_phonemize.data`).then((r) => r.arrayBuffer()),
    ]).then(([wasm, data]) => ({ wasm, data }));
  }
  return phonemizeAssets;
}

export class PiperSession {
  // wasmRoot: absolute URL of vendor/piper/ inside the extension.
  constructor({ wasmRoot }) {
    this.wasmRoot = wasmRoot;
    this.voiceId = null;
    this.ortSession = null;
    this.config = null;
    // Must stay 1: SharedArrayBuffer exists in extension contexts, but ort's
    // thread pool spawns blob: workers, which MV3 CSP forbids (script-src
    // allows only 'self' and 'wasm-unsafe-eval') — threads crash at startup.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = `${wasmRoot}onnx/`;
  }

  async setVoice(voiceId, onProgress) {
    if (this.voiceId === voiceId && this.ortSession) return;
    await ensureVoiceDownloaded(voiceId, onProgress);
    const cfgFile = await opfsFile(`${voiceId}.onnx.json`);
    this.config = JSON.parse(await cfgFile.text());
    const modelFile = await opfsFile(`${voiceId}.onnx`);
    this.ortSession = await ort.InferenceSession.create(await modelFile.arrayBuffer());
    this.voiceId = voiceId;
  }

  async #phonemize(text) {
    const input = JSON.stringify([{ text: text.trim() }]);
    const assets = await loadPhonemizeAssets(this.wasmRoot);
    return new Promise((resolve, reject) => {
      createPiperPhonemize({
        print: (data) => resolve(JSON.parse(data).phoneme_ids),
        printErr: (message) => reject(new Error(message)),
        wasmBinary: assets.wasm,
        getPreloadedPackage: () => assets.data,
        locateFile: (url) => {
          if (url.endsWith('.wasm')) return `${this.wasmRoot}piper_phonemize.wasm`;
          if (url.endsWith('.data')) return `${this.wasmRoot}piper_phonemize.data`;
          return url;
        },
      })
        .then((module) => {
          module.callMain([
            '-l',
            this.config.espeak.voice,
            '--input',
            input,
            '--espeak_data',
            '/espeak-ng-data',
          ]);
        })
        .catch(reject);
    });
  }

  // rate 0.5–2 maps to Piper's length_scale (pitch-preserving speed change).
  async synthesize(text, rate = 1) {
    if (!this.ortSession) throw new Error('No voice loaded');
    const phonemeIds = await this.#phonemize(text);
    const c = this.config;
    const feeds = {
      input: new ort.Tensor('int64', phonemeIds, [1, phonemeIds.length]),
      input_lengths: new ort.Tensor('int64', [phonemeIds.length]),
      scales: new ort.Tensor('float32', [
        c.inference.noise_scale,
        c.inference.length_scale / rate,
        c.inference.noise_w,
      ]),
    };
    if (Object.keys(c.speaker_id_map ?? {}).length) {
      feeds.sid = new ort.Tensor('int64', [0]);
    }
    const { output } = await this.ortSession.run(feeds);
    return { pcm: new Float32Array(output.data), sampleRate: c.audio.sample_rate };
  }
}
