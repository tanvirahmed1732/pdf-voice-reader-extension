# PDF Voice Reader

Chrome extension that reads PDFs — and any web page — aloud with live word-by-word highlighting. PDFs open in the extension's own PDF.js-based reader tab (Chrome's built-in PDF viewer is sandboxed, so extensions can't read selections from it); regular web pages are read **in place** — you stay on the page while it highlights and speaks. Speaks with either your system voices or downloadable neural voices that run fully offline.

## Features

- **Own PDF reader tab** — selectable text, zoom, lazy page rendering
- **Read from selection** — select any text, press Read; speech starts there and continues to the end of the document
- **Page navigation** — the PDF toolbar has a page box (`Page [n] / total`) that reflects the page you're viewing and jumps to any page you type, plus a zoom % readout
- **Web pages too, in place** — on any normal page, select text, click the extension icon, press ▶ Play: reading starts at your selection right on the page (sentence + word highlighting, auto-scroll that follows nested scroll containers, click-any-text-to-jump) and continues until stopped. Controls live in the popup — reopen the icon to pause/resume/stop or change voice/speed mid-read. No selection = reads from the top
- **Live highlighting** — the current sentence and the word being spoken are highlighted and auto-scrolled into view (word-exact with system voices, estimated with neural voices)
- **Three voice families**
  - *Natural voices (online)* — Microsoft Edge "Read Aloud" neural narrators (the expressive, audiobook-style voices; Andrew is the default). Free, no API key, exact word-boundary highlighting. Needs internet. This is the most natural / emotional option
  - *System voices* (Web Speech API) — instant, offline, uses everything installed on your OS
  - *Neural voices* (Piper, ONNX in WebAssembly) — one-time ~64 MB model download, then fully offline. Only medium-quality models are offered: "high" models synthesize at ~0.3× realtime on single-threaded WASM (MV3 CSP forbids ort's thread pool, which spawns blob: workers), while medium models run ~3× realtime and read smoothly
- **Controls** — play/pause/resume/stop, speed 0.5×–2× (pitch-preserving for neural voices), skip sentence ⏮/⏭, click any text to jump the reading position
- **Keyboard** — `Space` play/pause, `←`/`→` skip sentence
- **Persistence** — voice and speed are remembered across sessions

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. *(Optional, for local PDF files)* On the extension's details page, enable **Allow access to file URLs**

## Usage

- On any PDF tab: click the extension icon → **Open this PDF in reader**
- On any normal web page: (optionally select where to start) → click the icon → **▶ Play** — reopen the icon anytime to pause/stop
- Or: click the icon → **Open a local PDF…** → pick or drag-drop a file
- Select text where you want to start, press **▶ Read**
- **Manage voices…** in the toolbar downloads neural voices (they appear in the voice picker once installed)

## Development

```
npm install            # dev dependencies only (the extension itself has no runtime deps)
npm run vendor:pdfjs   # re-copy pdf.mjs / pdf.worker.mjs after upgrading pdfjs-dist
npm run build:piper    # re-bundle the neural TTS layer after upgrading TTS packages
```

`vendor/` contains committed build outputs, so day-to-day development needs no build step — edit and reload the extension.

### Tests

```
node scripts/make-test-pdf.mjs   # generate test/test.pdf (once)
node scripts/e2e-smoke.mjs       # full UI smoke test in Playwright Chromium (17 checks)
node scripts/e2e-neural.mjs      # deep neural-path test (downloads a ~64 MB voice model)
```

The smoke test uses Playwright's Chromium build because branded Chrome 137+ no longer honors `--load-extension`.

## Architecture notes

- `reader/text-model.js` — builds one global text string from the PDF text content (with de-hyphenation), segments it into sentences with `Intl.Segmenter`, and maps character offsets ↔ text-layer DOM nodes
- Highlighting uses the **CSS Custom Highlight API** — no DOM mutation, so selection and offsets never break
- `tts/webspeech-engine.js` — one utterance per sentence; includes workarounds for Chrome's 15-second silence bug, empty `getVoices()` on first call, voices without boundary events, and pause-acts-as-stop remote voices
- `tts/neural-worker.js` + `scripts/piper-src.mjs` — Piper synthesis in a module worker; a custom `PiperSession` (instead of the package's `TtsSession`) exposes the length-scale for pitch-preserving speed control and fixes an upstream unawaited-OPFS-write race in model downloads
- In-page web reading: `background.js` (service worker) routes messages between the popup (controls + state), `content/content.js` (text extraction with DOM offset map + CSS Custom Highlight painting), and `offscreen/offscreen.js` (hosts the TTS engines; audio plays from the offscreen document while the user stays on the page). Two offscreen-specific gotchas the code works around: (1) the Edge engine plays via an **HTMLAudioElement, not Web Audio** — AudioContext playback in a hidden offscreen document blocks concurrent WebSocket connections, so the next sentence's synthesis stalls; (2) a hidden offscreen document is network-throttled the instant it stops producing audio (the silent gap between sentences), so `offscreen.js` plays a continuous **silent keep-alive `<audio>` loop** for the whole session to keep synthesis fast. The service worker can't do the synthesis itself (declarativeNetRequest header rewriting doesn't apply to SW WebSocket handshakes → 403). Net result: web reading works and reads every line; gaps are a bit larger than the PDF reader because the offscreen's background network is slower than a visible page's
- `tts/edge-engine.js` — Microsoft Edge Read-Aloud voices over WebSocket (SSML request, per-sentence MP3 + word-boundary metadata → exact highlighting). The endpoint 403s unless the handshake carries Edge-browser headers (`User-Agent`, the read-aloud extension `Origin`, a `muid` cookie), which page WebSockets can't set — `tts/edge-dnr.js` installs a `declarativeNetRequest` session rule that rewrites them. Header values / Chromium version mirror the current `edge-tts` project; if Microsoft changes the token scheme, bump `GEC_VERSION` and the DNR user-agent.
  - **Gapless playback pipeline** (the anti-stutter design): a lead of `PRELOAD` sentences is kept synthesized ahead of playback, and connections are both capped (`CONCURRENCY=2`) and **paced** (`CONN_GAP_MS`) — a tight request burst is what trips the rate limiter and causes the mid-read stalls, so requests stay gentle even while filling the lead. Retries (`MAX_RETRIES`) run in the background *during the lead*, so a transiently-failing sentence is recovered before playback reaches it — every line gets read. When a sentence still isn't ready, playback **waits for it to recover rather than skipping** (prefer reading the line over dropping it), bounded by `MAX_WAIT_MS` so a genuinely un-synthesizable sentence (dense math/code/email runs) can never become a long freeze — it skips only after that bound. Net effect: normal prose reads with perfectly uniform gaps, no pauses, and nothing skipped. A sustained outage (`MAX_CONSEC_FAIL` in a row) stops with a message. Errors/notices show inline in the reader toolbar. Tune/verify with `node scripts/verify-smooth.mjs` (add `ARXIV=1` for the worst-case stress input)
- Voice models are cached in OPFS; all WASM assets are packaged in the extension (`vendor/piper/`) — only the model data files are fetched at runtime

## Known limitations

- Scanned (image-only) PDFs have no text to read — a banner says so (no OCR)
- Multi-column PDFs are read in text-extraction order, which can occasionally interleave columns
- The espeak-ng phonemizer WASM used by Piper is GPLv3 — fine for personal use; revisit licensing before publishing to the Chrome Web Store

## Author

**Tanvir Ahmed** ([@tanvirahmed1732](https://github.com/tanvirahmed1732))

## License

MIT © 2026 Tanvir Ahmed — see [LICENSE](LICENSE). (The bundled espeak-ng phonemizer WASM used by the optional Piper voices is GPLv3; see Known limitations.)
