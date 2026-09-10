// Controls page. Hosted two ways: in the in-page sidebar iframe on web pages
// (content/sidebar.js, pinned to one tab via ?tabId) and in Chrome's side
// panel as the fallback on PDF/browser tabs. Both outlive tab switches and
// navigations, so everything tab-specific lives in refreshTab() and is re-run
// on tab changes; listeners are bound exactly once.
import { loadSettings, saveSettings } from '../reader/settings.js';

const openCurrentBtn = document.getElementById('open-current');
const currentHint = document.getElementById('current-hint');
const fileAccessSection = document.getElementById('file-access-section');
const openSettingsBtn = document.getElementById('open-settings');
const openLocalBtn = document.getElementById('open-local');
const playerSection = document.getElementById('player-section');
const playBtn = document.getElementById('pg-play');
const stopBtn = document.getElementById('pg-stop');
const voiceSel = document.getElementById('pg-voice');
const rateSel = document.getElementById('pg-rate');
const rateDownBtn = document.getElementById('pg-rate-down');
const rateUpBtn = document.getElementById('pg-rate-up');
const statusEl = document.getElementById('pg-status');
const modeInPageBtn = document.getElementById('mode-inpage');

let tab = null; // the tab the panel currently controls
let settings = null;
let state = null; // playback session from the service worker
let panelWindowId = null; // side panels are per-window; follow this window's tabs
let voicesLoaded = false;
let refreshSeq = 0; // drops stale refreshes when tabs change quickly

// ?tabId=… pins the target tab: the in-page sidebar iframe uses it (one
// iframe per tab), and tests open this page as a normal tab with it.
// ?embed=1 marks the in-page sidebar, whose host draws its own header.
const params = new URLSearchParams(location.search);
const tabOverride = params.get('tabId');
if (params.get('embed') === '1') document.body.classList.add('embed');

// Play button shows an icon + a label span so the label can be hidden or
// stacked by CSS at narrow widths.
function setPlayLabel(icon, label) {
  playBtn.querySelector('.ico').textContent = icon;
  playBtn.querySelector('.lbl').textContent = label;
}

const sw = (msg) => chrome.runtime.sendMessage({ ...msg, target: 'sw' });

function readerUrl(query) {
  const base = chrome.runtime.getURL('reader/reader.html');
  return query ? `${base}?${query}` : base;
}

function looksLikePdf(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:', 'file:'].includes(u.protocol)) return false;
    return u.pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

function isWebPage(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isReaderPage(url) {
  return typeof url === 'string' && url.startsWith(chrome.runtime.getURL('reader/'));
}

// True when the service worker's session belongs to the tab this panel shows.
function sessionIsForThisTab() {
  return !!(state && tab && state.tabId === tab.id);
}

// Clamped to 0.25–3, 0.05 steps. Non-preset values show as a custom option.
// persist=true saves the setting and pushes it to a running read.
async function setRate(rate, persist) {
  rate = Math.min(3, Math.max(0.25, Math.round(rate * 100) / 100));
  settings.rate = rate;
  const val = String(rate);
  const preset = [...rateSel.options].find(
    (o) => !o.classList.contains('custom-rate') && o.value === val,
  );
  let custom = rateSel.querySelector('option.custom-rate');
  if (preset) {
    if (custom) custom.remove();
  } else {
    if (!custom) {
      custom = document.createElement('option');
      custom.className = 'custom-rate';
      rateSel.appendChild(custom);
    }
    custom.value = val;
    custom.textContent = `${rate}×`;
  }
  rateSel.value = val;
  if (persist) {
    saveSettings(settings);
    if (sessionIsForThisTab()) await sw({ type: 'ui-set-rate', rate });
  }
}

// ---------- in-page player ----------

function selectedVoice() {
  const [kind, ...rest] = voiceSel.value.split(':');
  return { kind, id: rest.join(':') };
}

function renderPlayerState() {
  const active = sessionIsForThisTab() && state.status !== 'error';
  if (active && state.status === 'playing') {
    setPlayLabel('⏸', 'Pause');
    stopBtn.disabled = false;
    statusEl.textContent = state.note || `Reading sentence ${state.k + 1}/${state.total}`;
  } else if (active && state.status === 'paused') {
    setPlayLabel('▶', 'Resume');
    stopBtn.disabled = false;
    statusEl.textContent = `Paused at sentence ${state.k + 1}/${state.total}`;
  } else {
    setPlayLabel('▶', 'Play');
    stopBtn.disabled = true;
    statusEl.textContent =
      sessionIsForThisTab() && state.status === 'error'
        ? state.note
        : 'Starts from your selected text, if any, and keeps reading until you stop it.';
  }
}

function loadSystemVoices() {
  return new Promise((resolve) => {
    const now = speechSynthesis.getVoices();
    if (now.length) return resolve(now);
    const timer = setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
    speechSynthesis.addEventListener(
      'voiceschanged',
      () => {
        clearTimeout(timer);
        resolve(speechSynthesis.getVoices());
      },
      { once: true },
    );
  });
}

async function populateVoices() {
  voiceSel.textContent = '';

  try {
    const { EDGE_VOICES } = await import('../tts/edge-voices.js');
    const og = document.createElement('optgroup');
    og.label = 'Natural voices (online)';
    for (const v of EDGE_VOICES) {
      const opt = document.createElement('option');
      opt.value = `edge:${v.id}`;
      opt.textContent = v.name;
      og.appendChild(opt);
    }
    voiceSel.appendChild(og);
  } catch {
    // edge voices module unavailable
  }

  const sys = await loadSystemVoices();
  const english = sys.filter((v) => v.lang?.toLowerCase().startsWith('en'));
  const rest = sys.filter((v) => !v.lang?.toLowerCase().startsWith('en'));
  const sysGroup = document.createElement('optgroup');
  sysGroup.label = 'System voices';
  for (const v of [...english, ...rest]) {
    const opt = document.createElement('option');
    opt.value = `system:${v.voiceURI}`;
    opt.textContent = `${v.name} (${v.lang})`;
    sysGroup.appendChild(opt);
  }
  voiceSel.appendChild(sysGroup);

  try {
    const { installedNeuralVoices } = await import('../reader/voice-catalog.js');
    const installed = await installedNeuralVoices();
    if (installed.length) {
      const og = document.createElement('optgroup');
      og.label = 'Neural voices (downloaded)';
      for (const v of installed) {
        const opt = document.createElement('option');
        opt.value = `neural:${v.id}`;
        opt.textContent = v.name;
        og.appendChild(opt);
      }
      voiceSel.appendChild(og);
    }
  } catch {
    // neural bundle unavailable — system voices still work
  }

  const preferredId =
    settings.engineKind === 'edge'
      ? settings.edgeVoiceId
      : settings.engineKind === 'neural'
        ? settings.neuralVoiceId
        : settings.systemVoiceId;
  const preferred = preferredId ? `${settings.engineKind}:${preferredId}` : null;
  if (preferred && [...voiceSel.options].some((o) => o.value === preferred)) {
    voiceSel.value = preferred;
  }
}

async function refreshState() {
  const resp = await sw({ type: 'ui-state' }).catch(() => null);
  if (resp) state = resp.state;
  renderPlayerState();
}

function bindPlayerControls() {
  playBtn.addEventListener('click', async () => {
    if (!tab) return;
    if (sessionIsForThisTab() && state.status === 'playing') {
      state = (await sw({ type: 'ui-pause' })).state;
    } else if (sessionIsForThisTab() && state.status === 'paused') {
      state = (await sw({ type: 'ui-resume' })).state;
    } else {
      playBtn.disabled = true;
      statusEl.textContent = 'Starting…';
      const resp = await sw({
        type: 'ui-play',
        tabId: tab.id,
        voice: selectedVoice(),
        rate: settings.rate,
      });
      playBtn.disabled = false;
      if (resp?.error) {
        statusEl.textContent = resp.error;
        return;
      }
      state = resp.state;
    }
    renderPlayerState();
  });

  stopBtn.addEventListener('click', async () => {
    await sw({ type: 'ui-stop' });
    state = null;
    renderPlayerState();
  });

  voiceSel.addEventListener('change', async () => {
    const voice = selectedVoice();
    settings.engineKind = voice.kind;
    if (voice.kind === 'edge') settings.edgeVoiceId = voice.id;
    else if (voice.kind === 'neural') settings.neuralVoiceId = voice.id;
    else settings.systemVoiceId = voice.id;
    saveSettings(settings);
    if (sessionIsForThisTab()) await sw({ type: 'ui-set-voice', voice });
  });

  rateSel.addEventListener('change', () => setRate(Number(rateSel.value), true));
  rateDownBtn.addEventListener('click', () => setRate(settings.rate - 0.05, true));
  rateUpBtn.addEventListener('click', () => setRate(settings.rate + 0.05, true));

  // Keyboard while the panel has focus (the page's own handlers can't fire
  // then): Space toggles play/pause, ←/→ skip to the previous/next sentence.
  // Ignored when a dropdown/field is focused or the player isn't shown.
  document.addEventListener('keydown', async (e) => {
    const t = e.target;
    if (t && /^(SELECT|INPUT|TEXTAREA)$/.test(t.tagName)) return;
    if (playerSection.hidden) return;
    if (e.code === 'Space') {
      e.preventDefault();
      playBtn.click();
    } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && sessionIsForThisTab()) {
      e.preventDefault();
      const resp = await sw({ type: 'ui-skip', delta: e.code === 'ArrowLeft' ? -1 : 1 });
      if (resp?.state) {
        state = resp.state;
        renderPlayerState();
      }
    }
  });

  // Live progress while the panel stays open.
  setInterval(() => {
    if (!playerSection.hidden) refreshState();
  }, 1000);
}

// ---------- tab-specific view ----------

async function showForTab() {
  const seq = ++refreshSeq;
  const url = tab?.url ?? '';

  openCurrentBtn.hidden = true;
  openCurrentBtn.disabled = true;
  fileAccessSection.hidden = true;
  playerSection.hidden = false;
  currentHint.textContent = '';

  if (looksLikePdf(url)) {
    playerSection.hidden = true;
    openCurrentBtn.hidden = false;
    if (url.startsWith('file:')) {
      const allowed = await chrome.extension.isAllowedFileSchemeAccess();
      if (seq !== refreshSeq) return;
      if (allowed) {
        openCurrentBtn.disabled = false;
      } else {
        fileAccessSection.hidden = false;
        currentHint.textContent = 'Local PDF detected — file access is not enabled yet.';
      }
    } else {
      openCurrentBtn.disabled = false;
    }
  } else if (isReaderPage(url)) {
    playerSection.hidden = true;
    currentHint.textContent = 'The PDF reader is open in this tab. Use its own toolbar to play.';
  } else if (isWebPage(url)) {
    if (!voicesLoaded) {
      voicesLoaded = true;
      setRate(settings.rate, false);
      await populateVoices();
      if (seq !== refreshSeq) return;
    }
    await refreshState();
  } else {
    playerSection.hidden = true;
    currentHint.textContent =
      'This page cannot be read (browser pages are off-limits to extensions). Switch to a web page or PDF.';
  }
}

async function refreshTab() {
  try {
    tab = tabOverride
      ? await chrome.tabs.get(Number(tabOverride))
      : ((await chrome.tabs.query({ active: true, windowId: panelWindowId }))[0] ?? null);
  } catch {
    tab = null;
  }
  await showForTab();
}

function watchTabs() {
  chrome.tabs.onActivated.addListener(({ windowId }) => {
    if (windowId === panelWindowId) refreshTab();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tab && tabId === tab.id && changeInfo.url !== undefined) refreshTab();
  });
}

// ---------- init ----------

async function init() {
  settings = await loadSettings();
  panelWindowId = (await chrome.windows.getCurrent()).id;

  bindPlayerControls();

  openCurrentBtn.addEventListener('click', async () => {
    if (!tab?.url) return;
    await chrome.tabs.create({ url: readerUrl(`file=${encodeURIComponent(tab.url)}`) });
  });

  openLocalBtn.addEventListener('click', async () => {
    await chrome.tabs.create({ url: readerUrl(null) });
  });

  openSettingsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  });

  // Chrome side panel → in-page sidebar. The worker injects the sidebar on
  // this window's active tab; this panel then closes itself.
  modeInPageBtn.addEventListener('click', async () => {
    const resp = await sw({ type: 'sidebar-mode', mode: 'push', windowId: panelWindowId }).catch(() => null);
    if (resp?.ok) {
      window.close();
    } else {
      currentHint.textContent = resp?.error ?? 'Could not open the in-page sidebar.';
    }
  });

  watchTabs();
  await refreshTab();
}

init();
