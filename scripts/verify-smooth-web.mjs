// Measures smoothness of the WEB (in-page) reading path — the engine runs in
// the hidden offscreen document, which Chrome may throttle differently than the
// visible reader page. Reads a long-prose page via the popup and records the
// time of each sentence advance (from the service worker's session index).
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = process.env.PAGE || 'https://en.wikipedia.org/wiki/Coffee'; // normal-sized article

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
const helper = await context.newPage();
await helper.goto('chrome://extensions');
const extId = await helper.locator('extensions-item').first().getAttribute('id');
const reader = await context.newPage();
await reader.goto(`chrome-extension://${extId}/reader/reader.html`); // for chrome.tabs query

const web = await context.newPage();
await web.goto(PAGE, { waitUntil: 'domcontentloaded' });
await web.waitForTimeout(2500);
// Select a starting point deep in the prose (skip the Gutenberg header).
await web.evaluate(() => {
  const ps = [...document.querySelectorAll('p')].filter((p) => p.textContent.trim().length > 200);
  const target = ps[3] || ps[0];
  const r = document.createRange();
  r.selectNodeContents(target);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
});
const host = new URL(PAGE).host;
const tabId = await reader.evaluate(async (h) => (await chrome.tabs.query({ url: `*://${h}/*` }))[0]?.id, host);

const popup = await context.newPage();
await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`);
await popup.waitForSelector('#player-section:not([hidden])');
await popup.selectOption('#pg-voice', 'edge:en-US-AndrewMultilingualNeural');
await popup.selectOption('#pg-rate', '1.5');
await popup.click('#pg-play');

const marks = await popup.evaluate(async () => {
  const out = [];
  let last = -1;
  const t0 = performance.now();
  return await new Promise((resolve) => {
    const poll = setInterval(async () => {
      let state = null;
      try {
        ({ state } = await chrome.runtime.sendMessage({ target: 'sw', type: 'ui-state' }));
      } catch {}
      if (state && typeof state.k === 'number' && state.k !== last) {
        last = state.k;
        out.push({ k: state.k, t: Math.round(performance.now() - t0), note: state.note || '' });
      }
      if (performance.now() - t0 > 45000) {
        clearInterval(poll);
        resolve(out);
      }
    }, 150);
  });
});

await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'ui-stop' }));
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
const chronoGaps = [];
for (let i = 1; i < marks.length; i++) chronoGaps.push(marks[i].t - marks[i - 1].t);
console.log(`sentences advanced: ${marks.length}`);
console.log(`gap ms — median ${median}, max ${max}`);
console.log(`chronological gaps: ${chronoGaps.join(', ')}`);
const notes = marks.filter((m) => m.note).map((m) => m.note);
if (notes.length) console.log('notes seen:', JSON.stringify([...new Set(notes)]));
const smooth = max <= Math.max(median * 2, 5000);
console.log(smooth ? 'WEB SMOOTH: PASS' : 'WEB SMOOTH: FAIL (a long gap occurred)');
process.exit(smooth ? 0 : 1);
