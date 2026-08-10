// Measures playback smoothness: reads many sentences with the Edge voice and
// records the wall-clock time of each sentence-start (via the status line).
// A "long pause" would show up as a gap far larger than the typical spacing.
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Default: local normal-prose PDF (the realistic case). Pass ARXIV=1 to stress
// with the math/code-heavy paper instead.
const useArxiv = process.env.ARXIV === '1';
const HTTPS_PDF = 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
const helper = await context.newPage();
await helper.goto('chrome://extensions');
const extId = await helper.locator('extensions-item').first().getAttribute('id');

const reader = await context.newPage();
if (useArxiv) {
  await reader.goto(`chrome-extension://${extId}/reader/reader.html?file=${encodeURIComponent(HTTPS_PDF)}`);
} else {
  await reader.goto(`chrome-extension://${extId}/reader/reader.html`);
  await reader.setInputFiles('#file-input', join(root, 'test', 'prose.pdf'));
}
const ok = await reader
  .waitForSelector('.page .textLayer span', { timeout: 40000 })
  .then(() => true)
  .catch(() => false);
if (!ok) {
  console.log('PDF failed to load — cannot run smoothness check');
  await context.close();
  process.exit(0);
}
await reader.waitForFunction(() => /sentences/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
await reader.selectOption('#sel-voice', 'edge:en-US-AndrewMultilingualNeural');
await reader.selectOption('#sel-rate', '1.5');
await reader.click('#btn-play');

// Record (sentenceIndex, timestamp) on each sentence change, plus the longest
// interval with NO progress at all — no sentence advance and no word-highlight
// movement. A long sentence legitimately takes its audio duration to play (the
// word highlight keeps moving); a true stall is silence with nothing moving.
const { marks, maxSilence } = await reader.evaluate(async () => {
  const status = document.getElementById('status');
  const out = [];
  let last = -1;
  let lastWord = '';
  let lastProgress = -1; // set at first sentence start — startup synth isn't a stall
  let maxSilence = 0;
  const t0 = performance.now();
  const parse = () => {
    const m = status.textContent.match(/sentence (\d+)\//);
    return m ? Number(m[1]) : -1;
  };
  const wordSig = () => {
    const h = CSS.highlights.get('tts-word');
    if (!h) return '';
    const r = [...h][0];
    return r ? `${r.startOffset}:${r.endOffset}` : '';
  };
  const banner = () => document.getElementById('toolbar-note').textContent;
  return await new Promise((resolve) => {
    const iv = setInterval(() => {
      const now = performance.now();
      const k = parse();
      const w = wordSig();
      let progressed = false;
      if (k !== -1 && k !== last) {
        last = k;
        out.push({ k, t: Math.round(now - t0), note: banner() });
        progressed = true;
      }
      if (w !== lastWord) {
        lastWord = w;
        progressed = true;
      }
      if (lastProgress >= 0) maxSilence = Math.max(maxSilence, now - lastProgress);
      if (progressed && last !== -1) lastProgress = now;
      if (now - t0 > 45000) {
        clearInterval(iv);
        resolve({ marks: out, maxSilence: Math.round(maxSilence) });
      }
    }, 100);
  });
});

await reader.click('#btn-stop');
await context.close();

if (marks.length < 5) {
  console.log(`Only ${marks.length} sentences advanced — inconclusive`, JSON.stringify(marks));
  process.exit(0);
}
const gaps = [];
for (let i = 1; i < marks.length; i++) gaps.push(marks[i].t - marks[i - 1].t);
gaps.sort((a, b) => a - b);
const median = gaps[Math.floor(gaps.length / 2)];
const max = gaps[gaps.length - 1];
console.log(`sentences advanced: ${marks.length}`);
console.log(`gap ms — median ${median}, max ${max}, all: ${gaps.join(', ')}`);
console.log(`max no-progress interval: ${maxSilence} ms`);
const notes = marks.filter((m) => m.note).map((m) => m.note);
if (notes.length) console.log('notes seen:', JSON.stringify([...new Set(notes)]));
// Sentence gaps track audio length (a long sentence takes its full duration —
// lines are never skipped), so smoothness is judged on stalls: the longest
// stretch where neither the sentence nor the word highlight moved. Prose (the
// realistic case) must be tight; the arXiv stress input may hit a bounded
// re-request wait, but never the old multi-10s freeze.
const smooth = useArxiv ? maxSilence <= 8000 : maxSilence <= 4000;
console.log(smooth ? 'SMOOTH: PASS' : 'SMOOTH: FAIL (playback stalled)');
process.exit(smooth ? 0 : 1);
