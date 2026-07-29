// Deep test of the neural voice path: downloads a Piper voice (cached in
// OPFS) and synthesizes sentences through the same worker the reader uses.
//
// Run: node scripts/e2e-neural.mjs
// Pick a voice: VOICE=en_US-ryan-high node scripts/e2e-neural.mjs
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});

try {
  const extPage = await context.newPage();
  await extPage.goto('chrome://extensions');
  const extId = await extPage.locator('extensions-item').first().getAttribute('id');

  const page = await context.newPage();
  page.on('console', (msg) => console.log(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
  await page.goto(`chrome-extension://${extId}/reader/reader.html`);

  const voiceId = process.env.VOICE || 'en_US-lessac-medium';
  console.log(`Downloading ${voiceId} and synthesizing…`);
  const result = await page.evaluate(async (voiceId) => {
    const t0 = performance.now();
    const worker = new Worker(chrome.runtime.getURL('tts/neural-worker.js'), { type: 'module' });
    const send = (payload) =>
      new Promise((resolve, reject) => {
        const reqId = Math.floor(performance.now() * 1000);
        const onMsg = (e) => {
          if (e.data.reqId !== reqId) return;
          if (e.data.type === 'progress') {
            return; // keep listening
          }
          worker.removeEventListener('message', onMsg);
          if (e.data.type === 'error') reject(new Error(e.data.message));
          else resolve(e.data);
        };
        worker.addEventListener('message', onMsg);
        worker.postMessage({ ...payload, reqId });
      });

    await send({ type: 'init', voiceId, wasmRoot: chrome.runtime.getURL('vendor/piper/') });
    const tInit = performance.now();

    const audio = await send({ type: 'synth', text: 'Hello world. This is a neural voice test.', rate: 1 });
    const tSynth = performance.now();

    // Warm run: phonemizer assets are now cached — this is steady-state speed.
    const warmText =
      'Reading aloud should feel smooth, with each sentence ready before the previous one finishes playing.';
    const tWarm0 = performance.now();
    const warm = await send({ type: 'synth', text: warmText, rate: 1 });
    const tWarm = performance.now();

    const fast = await send({ type: 'synth', text: 'Speed test sentence.', rate: 2 });

    const warmDuration = warm.pcm.length / warm.sampleRate;
    return {
      initMs: Math.round(tInit - t0),
      firstSynthMs: Math.round(tSynth - tInit),
      warmSynthMs: Math.round(tWarm - tWarm0),
      warmAudioSec: warmDuration.toFixed(2),
      realtimeFactor: (warmDuration / ((tWarm - tWarm0) / 1000)).toFixed(2),
      samples: audio.pcm.length,
      sampleRate: audio.sampleRate,
      durationSec: (audio.pcm.length / audio.sampleRate).toFixed(2),
      fastDurationSec: (fast.pcm.length / fast.sampleRate).toFixed(2),
      nonSilent: audio.pcm.some((v) => Math.abs(v) > 0.05),
    };
  }, voiceId);

  console.log(JSON.stringify(result, null, 2));
  const ok = result.samples > 10000 && result.nonSilent && Number(result.fastDurationSec) < Number(result.durationSec);
  console.log(ok ? '\nNEURAL PATH: PASS' : '\nNEURAL PATH: FAIL');
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  console.log(`NEURAL PATH: FAIL — ${err}`);
  process.exitCode = 1;
} finally {
  await context.close();
}
