// Visual check: select a phrase mid-page, press Read, screenshot highlights.
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTTPS_PDF = 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
const extPage = await context.newPage();
await extPage.goto('chrome://extensions');
const extId = await extPage.locator('extensions-item').first().getAttribute('id');

const reader = await context.newPage();
await reader.setViewportSize({ width: 1400, height: 1000 });
await reader.goto(`chrome-extension://${extId}/reader/reader.html?file=${encodeURIComponent(HTTPS_PDF)}`);
await reader.waitForSelector('.page .textLayer span', { timeout: 45000 });
await reader.waitForFunction(() => /sentences/.test(document.getElementById('status').textContent), null, { timeout: 20000 });

// Select a phrase inside the abstract (double-click a mid-page word).
const target = reader.locator('.textLayer span', { hasText: 'Dynamic languages such as JavaScript' }).first();
await target.dblclick();
await reader.click('#btn-play');
await reader.waitForFunction(() => CSS.highlights.has('tts-word'), null, { timeout: 10000 });
await reader.waitForTimeout(2500);

await reader.screenshot({ path: join(root, 'test', 'visual-check.png') });
console.log('saved test/visual-check.png');
console.log('status:', await reader.locator('#status').textContent());
await context.close();
