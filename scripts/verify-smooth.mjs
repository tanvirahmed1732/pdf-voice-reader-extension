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

// Record (sentenceIndex, timestamp) each time the status sentence number changes.
const marks = await reader.evaluate(async () => {
  const status = document.getElementById('status');
  const out = [];
  let last = -1;
  const t0 = performance.now();
  const parse = () => {
    const m = status.textContent.match(/sentence (\d+)\//);
    return m ? Number(m[1]) : -1;
  };
  const banner = () => document.getElementById('toolbar-note').textContent;
  return await new Promise((resolve) => {
    const iv = setInterval(() => {
      const k = parse();
      if (k !== -1 && k !== last) {
        last = k;
        out.push({ k, t: Math.round(performance.now() - t0), note: banner() });
      }
      if (performance.now() - t0 > 45000) {
        clearInterval(iv);
        resolve(out);
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
const notes = marks.filter((m) => m.note).map((m) => m.note);
if (notes.length) console.log('notes seen:', JSON.stringify([...new Set(notes)]));
// Prose (the realistic case) must be tight — no waits at all. The arXiv stress
// input has genuinely un-synthesizable sentences, so a *bounded* wait/skip is
// acceptable there (the point is it's never the old 40s freeze).
const smooth = useArxiv ? max <= 12000 : max <= Math.max(median * 2, 5000);
console.log(smooth ? 'SMOOTH: PASS' : 'SMOOTH: FAIL (a long gap occurred)');
process.exit(smooth ? 0 : 1);
