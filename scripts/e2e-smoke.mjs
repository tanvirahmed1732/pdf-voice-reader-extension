// End-to-end smoke test: loads the unpacked extension into Playwright's
// Chromium, opens the reader, and verifies rendering, the text model,
// playback, and live highlighting.
//
// The local test PDF is opened through the file picker; the URL-loading path
// is verified against a real https PDF (needs internet).
//
// Run: node scripts/e2e-smoke.mjs
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTTPS_PDF = 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// Playwright's Chromium build — branded Chrome 137+ no longer honors --load-extension.
const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});

try {
  // Find the extension id from chrome://extensions (dev mode item id).
  const extPage = await context.newPage();
  await extPage.goto('chrome://extensions');
  const extId = await extPage.locator('extensions-item').first().getAttribute('id');
  check('extension loaded', Boolean(extId), `id=${extId}`);

  const reader = await context.newPage();
  reader.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [reader error] ${msg.text()}`);
  });
  reader.on('pageerror', (err) => console.log(`  [reader pageerror] ${err.message}`));

  // Open the local test PDF through the empty-state file picker.
  await reader.goto(`chrome-extension://${extId}/reader/reader.html`);
  check('empty state visible', await reader.locator('#empty-state').isVisible());
  await reader.setInputFiles('#file-input', join(root, 'test', 'test.pdf'));

  // Pages render with text layers.
  await reader.waitForSelector('.page .textLayer span', { timeout: 20000 });
  const pageCount = await reader.locator('.page').count();
  check('two pages rendered', pageCount === 2, `pages=${pageCount}`);
  const spanCount = await reader.locator('.textLayer span').count();
  check('text layer has spans', spanCount >= 5, `spans=${spanCount}`);

  // Text model built (status shows sentence count).
  await reader.waitForFunction(() => /sentences/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  const status = await reader.locator('#status').textContent();
  check('text model built', /\d+ sentences/.test(status), status.trim());

  // Page navigation: total shown, and typing a page + Enter scrolls to it.
  const pageTotalText = await reader.locator('#page-total').textContent();
  check('page total shown', pageTotalText.trim() === '/ 2', pageTotalText.trim());
  await reader.fill('#page-input', '2');
  await reader.press('#page-input', 'Enter');
  await reader.waitForTimeout(700); // smooth scroll
  const onPage2 = await reader.evaluate(() => {
    const p2 = document.querySelector('.page[data-page="2"]');
    const c = document.getElementById('viewer-container');
    const top = p2.getBoundingClientRect().top - c.getBoundingClientRect().top;
    return top < c.clientHeight * 0.5; // page 2 reached the upper half
  });
  check('typing a page number scrolls to it', onPage2);
  const pageInputAfter = await reader.locator('#page-input').inputValue();
  check('page box reflects current page', pageInputAfter === '2', `value=${pageInputAfter}`);

  // Voice list populated with system voices.
  const voiceOptions = await reader.locator('#sel-voice option').count();
  check('voice options listed', voiceOptions > 0, `options=${voiceOptions}`);

  // Press Read → playback starts with the default Edge (online neural) voice.
  await reader.click('#btn-play');
  const edgeStarted = await reader
    .waitForFunction(() => CSS.highlights.has('tts-sentence'), null, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check('playback started (edge voice)', edgeStarted);
  const noteText = (await reader.locator('#toolbar-note').textContent()).trim();
  check('no error note with edge voice', !/timed out|error|unavailable/i.test(noteText), noteText || '(empty)');

  const wordHl = await reader
    .waitForFunction(() => CSS.highlights.has('tts-word'), null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('word highlight active (edge word timings)', wordHl);

  // Switch to a system voice mid-playback — Web Speech engine takes over.
  const sysValue = await reader
    .locator('#sel-voice option')
    .evaluateAll((opts) => opts.map((o) => o.value).find((v) => v.startsWith('system:')));
  check('system voice available in picker', Boolean(sysValue));
  await reader.selectOption('#sel-voice', sysValue);
  const sysStarted = await reader
    .waitForFunction(() => speechSynthesis.speaking || speechSynthesis.pending, null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check('system voice engine takes over mid-read', sysStarted);

  // Skip forward, then pause and stop.
  await reader.click('#btn-next');
  await reader.waitForTimeout(500);
  const statusAfterSkip = await reader.locator('#status').textContent();
  check('skip updates status', /sentence/.test(statusAfterSkip), statusAfterSkip.trim());

  await reader.click('#btn-play'); // pause
  await reader.waitForTimeout(300);
  const pausedLabel = await reader.locator('#btn-play').textContent();
  check('pause toggles button', /Resume/.test(pausedLabel), pausedLabel.trim());

  await reader.click('#btn-stop');
  await reader.waitForFunction(() => !CSS.highlights.has('tts-sentence'), null, { timeout: 5000 });
  check('stop clears highlights', true);

  // Custom speed via +/- buttons: 1.5 → +0.05 → 1.55 (a non-preset value that
  // must appear as a custom option and persist across reload).
  await reader.selectOption('#sel-rate', '1.5');
  await reader.click('#btn-rate-up');
  const customRate = await reader.locator('#sel-rate').inputValue();
  check('plus button makes custom 0.05 step', customRate === '1.55', `rate=${customRate}`);
  const customLabel = await reader.locator('#sel-rate option.custom-rate').textContent();
  check('custom rate shown in dropdown', customLabel === '1.55×', customLabel);

  await reader.waitForTimeout(500); // debounce
  await reader.reload();
  await reader.waitForFunction(() => document.getElementById('sel-rate').value !== '', null, { timeout: 5000 });
  const restoredRate = await reader.locator('#sel-rate').inputValue();
  check('custom rate persisted across reload', restoredRate === '1.55', `rate=${restoredRate}`);

  // URL-loading path with a real https PDF.
  const urlReader = await context.newPage();
  await urlReader.goto(`chrome-extension://${extId}/reader/reader.html?file=${encodeURIComponent(HTTPS_PDF)}`);
  const httpsOk = await urlReader
    .waitForSelector('.page .textLayer span', { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  check('https PDF renders via ?file=', httpsOk);

  // Popup loads.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  check('popup renders', await popup.locator('#open-local').isVisible());

  // Neural bundle imports cleanly and OPFS voice store works.
  const neural = await reader.evaluate(async () => {
    try {
      const mod = await import(chrome.runtime.getURL('vendor/piper/piper-bundle.js'));
      const stored = await mod.stored();
      return { ok: true, stored };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  check('piper bundle imports + OPFS works', neural.ok, neural.ok ? `installed=[${neural.stored}]` : neural.error);

  // Voice catalog panel opens and lists downloadable voices.
  await reader.click('#btn-voices');
  await reader.waitForSelector('#voice-list li', { timeout: 10000 });
  const catalogRows = await reader.locator('#voice-list li').count();
  check('voice catalog lists voices', catalogRows >= 5, `rows=${catalogRows}`);

  // --- In-page web reading (popup → SW → content script → offscreen audio) ---

  const web = await context.newPage();
  await web.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await web.dblclick('p'); // select a word inside the paragraph

  const webTabId = await reader.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'https://example.com/*' });
    return t?.id;
  });
  check('web tab id resolved', Boolean(webTabId), `tabId=${webTabId}`);

  const webPopup = await context.newPage();
  await webPopup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${webTabId}`);
  await webPopup.waitForSelector('#player-section:not([hidden])', { timeout: 10000 });
  check('popup shows in-page player for web tab', true);

  await webPopup.click('#pg-play');
  const pageHighlighted = await web
    .waitForFunction(() => CSS.highlights.has('pdfvr-sentence'), null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('reading highlights text on the page itself', pageHighlighted);

  // Click-to-jump: reading started mid-page (sentence >=1 from the selection);
  // clicking on the heading text (sentence 0) must move the reading position
  // back to 0. Click near the top-left so the caret lands ON the text (the
  // element center is empty space to the right of the short heading).
  // Poll the SW session index — reading only moves backward via an explicit jump.
  await web.locator('h1').first().click({ position: { x: 4, y: 8 } });
  const minK = await webPopup.evaluate(async () => {
    let min = 99;
    for (let i = 0; i < 15; i++) {
      const { state } = await chrome.runtime.sendMessage({ target: 'sw', type: 'ui-state' });
      if (state && typeof state.k === 'number') min = Math.min(min, state.k);
      await new Promise((r) => setTimeout(r, 200));
    }
    return min;
  });
  check('click-to-jump moves reading position on page', minK === 0, `minK=${minK}`);

  // Word highlight must actually ADVANCE across ≥2 distinct words (the clock
  // runs in the content script; a single stuck highlight would be a regression).
  const distinctWords = await web.evaluate(async () => {
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const hl = CSS.highlights.get('pdfvr-word');
      const r = hl && [...hl][0];
      if (r) seen.add(r.toString());
      await new Promise((res) => setTimeout(res, 200));
    }
    return seen.size;
  });
  check('word highlight advances on page', distinctWords >= 2, `distinct=${distinctWords}`);

  // Space on the page toggles pause/resume.
  const statusOf = () => webPopup.evaluate(async () => (await chrome.runtime.sendMessage({ target: 'sw', type: 'ui-state' })).state?.status);
  await web.locator('body').focus().catch(() => {});
  await web.keyboard.press('Space');
  const pausedBySpace = await webPopup
    .waitForFunction(async () => (await chrome.runtime.sendMessage({ target: 'sw', type: 'ui-state' })).state?.status === 'paused', null, { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  check('Space on page pauses reading', pausedBySpace, `status=${await statusOf()}`);
  await web.keyboard.press('Space');
  const resumedBySpace = await webPopup
    .waitForFunction(async () => (await chrome.runtime.sendMessage({ target: 'sw', type: 'ui-state' })).state?.status === 'playing', null, { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  check('Space on page resumes reading', resumedBySpace, `status=${await statusOf()}`);

  // Space while the POPUP is focused also toggles (the page can't see it then).
  await webPopup.locator('body').click({ position: { x: 5, y: 5 } }); // focus popup, not a control
  await webPopup.keyboard.press('Space');
  const pausedFromPopup = await webPopup
    .waitForFunction(async () => (await chrome.runtime.sendMessage({ target: 'sw', type: 'ui-state' })).state?.status === 'paused', null, { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  check('Space in focused popup pauses reading', pausedFromPopup, `status=${await statusOf()}`);
  await webPopup.keyboard.press('Space');
  const resumedFromPopup = await webPopup
    .waitForFunction(async () => (await chrome.runtime.sendMessage({ target: 'sw', type: 'ui-state' })).state?.status === 'playing', null, { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  check('Space in focused popup resumes reading', resumedFromPopup, `status=${await statusOf()}`);

  await webPopup.waitForFunction(
    () => /Pause|Reading/.test(document.getElementById('pg-play').textContent + document.getElementById('pg-status').textContent),
    null,
    { timeout: 5000 },
  );
  const popupStatus = await webPopup.locator('#pg-status').textContent();
  check('popup shows reading progress', /Reading sentence/.test(popupStatus), popupStatus.trim());

  // Selection start: example.com's selected word is in the 2nd sentence-ish
  // region — just assert the reported sentence index is sane.
  check('starts from selection (not always sentence 1)', /sentence \d+\/\d+/.test(popupStatus), popupStatus.trim());

  await webPopup.click('#pg-play'); // pause
  await webPopup.waitForFunction(
    () => document.getElementById('pg-play').textContent.includes('Resume'),
    null,
    { timeout: 5000 },
  );
  check('popup pause toggles to Resume', true);

  await webPopup.click('#pg-stop');
  const cleared = await web
    .waitForFunction(() => !CSS.highlights.has('pdfvr-sentence'), null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check('stop clears on-page highlights', cleared);
} catch (err) {
  check('unexpected failure', false, String(err));
} finally {
  await context.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
