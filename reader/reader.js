// Reader page entry point: loads a PDF (or extracted web-page text), builds
// the text model, and wires the player toolbar, highlighting, and TTS
// engines together.

import { fileParam, filenameFromUrl, loadFromUrl, initFilePicker, FileAccessError } from './pdf-loader.js';
import { DocTextModel } from './text-model.js';
import { Highlighter } from './highlighter.js';
import { Player, PlayerState } from './player.js';
import { Toolbar } from './toolbar.js';
import { loadSettings, saveSettings } from './settings.js';
import { WebSpeechEngine } from '../tts/webspeech-engine.js';

const container = document.getElementById('viewer-container');
const pagesEl = document.getElementById('pages');
const emptyState = document.getElementById('empty-state');
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const loadingProgress = document.getElementById('loading-progress');
const toolbarNote = document.getElementById('toolbar-note');
const pageInput = document.getElementById('page-input');
const pageTotal = document.getElementById('page-total');
const zoomLevel = document.getElementById('zoom-level');
const pill = document.getElementById('autoscroll-pill');

const toolbar = new Toolbar();

let settings;
let activeView = null; // PdfView
let model = null;
let player = null;
let highlighter = null;
const engines = {}; // kind -> engine instance (lazy)

let noteTimer = null;
function setNote(text, autoClearMs) {
  toolbarNote.textContent = text || '';
  toolbarNote.title = text || '';
  clearTimeout(noteTimer);
  if (text && autoClearMs) {
    noteTimer = setTimeout(() => {
      toolbarNote.textContent = '';
      toolbarNote.title = '';
    }, autoClearMs);
  }
}
// Persistent message (errors, warnings) — stays until replaced.
function showBanner(text) {
  setNote(text, 0);
}
// Transient status (e.g. "reconnecting…") — clears itself.
function showNotice(text) {
  setNote(text, 5000);
}

function updateZoomLabel() {
  if (activeView && typeof activeView.scale === 'number') {
    zoomLevel.textContent = `${Math.round(activeView.scale * 100)}%`;
  }
}

function showLoading(text) {
  emptyState.hidden = true;
  loadingEl.hidden = false;
  loadingText.textContent = text;
  loadingProgress.value = 0;
}

async function getEngine(kind) {
  if (engines[kind]) return engines[kind];
  let engine;
  if (kind === 'neural') {
    const { NeuralEngine } = await import('../tts/neural-engine.js');
    engine = new NeuralEngine();
    engine.onVoiceProgress = (frac) =>
      toolbar.setStatus(`Downloading voice… ${Math.round(frac * 100)}%`);
  } else if (kind === 'edge') {
    const { EdgeEngine } = await import('../tts/edge-engine.js');
    engine = new EdgeEngine();
    engine.onNotice = (msg) => (msg ? showNotice(msg) : showBanner(''));
  } else {
    engine = new WebSpeechEngine();
  }
  await engine.init();
  engines[kind] = engine;
  return engine;
}

function voiceIdFor(kind) {
  if (kind === 'edge') return settings.edgeVoiceId;
  if (kind === 'neural') return settings.neuralVoiceId;
  return settings.systemVoiceId;
}

function storeVoice(kind, id) {
  settings.engineKind = kind;
  if (kind === 'edge') settings.edgeVoiceId = id;
  else if (kind === 'neural') settings.neuralVoiceId = id;
  else settings.systemVoiceId = id;
}

async function applyVoice(kind, id) {
  try {
    const engine = await getEngine(kind);
    await engine.setVoice(id);
    engine.setRate(settings.rate);
    player.setEngine(engine);
    storeVoice(kind, id);
    saveSettings(settings);
  } catch (err) {
    showBanner(`Could not activate voice: ${err.message}`);
  }
}

async function refreshVoiceList() {
  const groups = [];

  const { EDGE_VOICES } = await import('../tts/edge-voices.js');
  groups.push({
    label: 'Natural voices (online)',
    voices: EDGE_VOICES.map((v) => ({ value: `edge:${v.id}`, label: v.name })),
  });

  const systemEngine = await getEngine('system');
  const systemVoices = await systemEngine.listVoices();
  groups.push({
    label: 'System voices',
    voices: systemVoices.map((v) => ({ value: `system:${v.id}`, label: v.name })),
  });

  try {
    const { installedNeuralVoices } = await import('./voice-catalog.js');
    const installed = await installedNeuralVoices();
    groups.push({
      label: 'Neural voices (downloaded)',
      voices: installed.map((v) => ({ value: `neural:${v.id}`, label: v.name })),
    });
  } catch {
    // Neural support unavailable (bundle not built) — system voices still work.
  }

  const kind = settings.engineKind;
  const id = voiceIdFor(kind);
  toolbar.populateVoices(groups, id ? `${kind}:${id}` : null);
}

// Shared by the PDF and web-page paths once `model` and `activeView` exist.
async function setupPlayback(statusFor) {
  highlighter = new Highlighter(model, activeView, container, pill);
  player = new Player(model, highlighter);
  player.onStateChange = (s) => toolbar.setPlayState(s);
  player.onProgress = (k, page) => toolbar.setStatus(statusFor(k, page));
  player.onError = (message) => showBanner(message);
  activeView.onRelayout = () => highlighter.refresh();

  const kind = voiceIdFor(settings.engineKind) ? settings.engineKind : 'system';
  const id = voiceIdFor(kind);
  try {
    if (kind === 'neural') toolbar.setStatus(`Loading voice ${id}… (can take a while on first use)`);
    const engine = await getEngine(kind);
    if (id) {
      // A neural model that fails or wedges must never block the reader.
      const voiceReady = Promise.resolve(engine.setVoice(id));
      await (kind === 'neural'
        ? Promise.race([
            voiceReady,
            new Promise((_, reject) => setTimeout(() => reject(new Error('voice load timed out')), 90000)),
          ])
        : voiceReady);
    }
    engine.setRate(settings.rate);
    player.setEngine(engine);
  } catch (err) {
    if (kind !== 'system') {
      showBanner(`Voice "${id}" could not be loaded (${err.message}) — using a system voice instead.`);
    }
    const engine = await getEngine('system');
    engine.setRate(settings.rate);
    player.setEngine(engine);
  }
}

function wireToolbar() {
  toolbar.onPlay = () => {
    if (!model || !player) return;
    if (player.state !== PlayerState.IDLE) {
      player.toggle();
      return;
    }
    const offset = model.offsetFromSelection(activeView);
    if (offset != null) player.playFromOffset(offset);
    else player.playFrom(0);
  };

  toolbar.onStop = () => player?.stop();
  toolbar.onSkip = (delta) => player?.skip(delta);

  toolbar.onRateChange = (rate) => {
    settings.rate = rate;
    saveSettings(settings);
    player?.setRate(rate);
  };

  toolbar.onVoiceChange = ({ kind, id }) => applyVoice(kind, id);

  toolbar.onManageVoices = async () => {
    try {
      const catalog = await import('./voice-catalog.js');
      catalog.openVoicePanel({
        onInstalledChanged: refreshVoiceList,
        onSelectVoice: (id) => applyVoice('neural', id),
      });
    } catch {
      showBanner('Neural voices are not available in this build.');
    }
  };

  toolbar.onZoom = async (factor) => {
    await activeView?.setZoom(factor);
    updateZoomLabel();
  };

  const goToPage = () => {
    if (!activeView?.pdfDoc) return;
    const n = Math.min(Math.max(parseInt(pageInput.value, 10) || 1, 1), activeView.pdfDoc.numPages);
    pageInput.value = String(n);
    activeView.scrollToPage(n);
  };
  pageInput.addEventListener('change', goToPage);
  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goToPage();
      pageInput.blur();
    }
  });
}

function wireDocumentInteractions() {
  // Click-to-jump: while listening, click any text to move the reading position.
  container.addEventListener('click', (e) => {
    if (!model || !player?.isActive) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // don't steal a selection drag
    const offset = model.offsetFromPoint(e.clientX, e.clientY, activeView);
    if (offset != null) player.jumpTo(model.offsetToSentence(offset));
  });

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
    if (e.code === 'Space') {
      e.preventDefault();
      toolbar.onPlay?.();
    } else if (e.code === 'ArrowRight' && player?.isActive) {
      e.preventDefault();
      player.skip(1);
    } else if (e.code === 'ArrowLeft' && player?.isActive) {
      e.preventDefault();
      player.skip(-1);
    }
  });
}

async function openPdf(data, title) {
  showLoading('Preparing document…');
  document.title = `${title} – PDF Voice Reader`;

  const { PdfView } = await import('./pdf-view.js');
  const view = new PdfView(container, pagesEl);
  activeView = view;

  const pdfDoc = await view.open(data);
  loadingEl.hidden = true;

  // Page navigation: show total, reflect the visible page, allow jumping.
  pageTotal.textContent = `/ ${pdfDoc.numPages}`;
  pageInput.max = String(pdfDoc.numPages);
  pageInput.value = '1';
  pageInput.disabled = false;
  view.onPageChange = (p) => {
    if (document.activeElement !== pageInput) pageInput.value = String(p);
  };
  updateZoomLabel();

  showLoading('Extracting text…');
  model = await DocTextModel.build(view, pdfDoc.numPages, (p, total) => {
    loadingText.textContent = `Extracting text… page ${p}/${total}`;
    loadingProgress.value = Math.round((p / total) * 100);
  });
  loadingEl.hidden = true;

  if (model.totalTextLength < 40 && pdfDoc.numPages > 0) {
    showBanner('This PDF appears to be scanned images — no readable text was found, so nothing can be read aloud.');
  }

  await setupPlayback(
    (k, page) => `p.${page}/${pdfDoc.numPages} · sentence ${k + 1}/${model.sentences.length}`,
  );
  toolbar.setStatus(`${pdfDoc.numPages} pages · ${model.sentences.length} sentences`);
}

async function init() {
  settings = await loadSettings();
  // Retired voices (e.g. slow "high" models) map to a smooth replacement.
  try {
    const { migrateVoiceId } = await import('./voice-catalog.js');
    const migrated = migrateVoiceId(settings.neuralVoiceId);
    if (migrated !== settings.neuralVoiceId) {
      settings.neuralVoiceId = migrated;
      saveSettings(settings);
    }
  } catch {
    // neural bundle unavailable — nothing to migrate
  }
  toolbar.setRate(settings.rate);
  wireToolbar();
  wireDocumentInteractions();
  refreshVoiceList();

  initFilePicker(async (file) => {
    try {
      showLoading(`Loading ${file.name}…`);
      const data = new Uint8Array(await file.arrayBuffer());
      await openPdf(data, file.name);
    } catch (err) {
      loadingEl.hidden = true;
      emptyState.hidden = false;
      showBanner(`Could not open PDF: ${err.message}`);
    }
  });

  const url = fileParam();
  if (!url) return; // empty state stays visible

  try {
    const name = filenameFromUrl(url);
    showLoading(`Downloading ${name}…`);
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    let lastActivity = performance.now();
    // Some servers (login walls, blockers) accept the request but never send
    // the file — tell the user what to do instead of spinning forever.
    const stallTimer = setInterval(() => {
      if (performance.now() - lastActivity > 30000) {
        showBanner(
          'The download seems stuck. The site may require a login or block downloads — save the PDF to your computer and use "Open a local PDF" instead.',
        );
      }
    }, 5000);
    try {
      const data = await loadFromUrl(url, (received, total) => {
        lastActivity = performance.now();
        loadingText.textContent = total
          ? `Downloading ${name}… ${mb(received)} / ${mb(total)} MB`
          : `Downloading ${name}… ${mb(received)} MB`;
        if (total) loadingProgress.value = Math.round((received / total) * 100);
      });
      showBanner('');
      await openPdf(data, name);
    } finally {
      clearInterval(stallTimer);
    }
  } catch (err) {
    loadingEl.hidden = true;
    emptyState.hidden = false;
    if (err instanceof FileAccessError) {
      showBanner(
        'Local file access is not enabled. Open chrome://extensions, find PDF Voice Reader, turn on "Allow access to file URLs", then reload this page.',
      );
    } else {
      showBanner(`Could not open PDF: ${err.message}`);
    }
  }
}

init();
