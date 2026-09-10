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
    if (state && state.tabId === tab.id) await sw({ type: 'ui-set-rate', rate });
  }
}

let tab = null;
let settings = null;
let state = null; // playback session from the service worker

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

// ---------- in-page player ----------

function selectedVoice() {
  const [kind, ...rest] = voiceSel.value.split(':');
  return { kind, id: rest.join(':') };
}

function renderPlayerState() {
  const active = state && state.tabId === tab.id && state.status !== 'error';
  if (active && state.status === 'playing') {
    playBtn.textContent = '⏸ Pause';
    stopBtn.disabled = false;
    statusEl.textContent = state.note || `Reading sentence ${state.k + 1}/${state.total}`;
  } else if (active && state.status === 'paused') {
    playBtn.textContent = '▶ Resume';
    stopBtn.disabled = false;
    statusEl.textContent = `Paused at sentence ${state.k + 1}/${state.total}`;
  } else {
    playBtn.textContent = '▶ Play';
    stopBtn.disabled = true;
    statusEl.textContent =
      state?.status === 'error'
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

async function initPlayer() {
  playerSection.hidden = false;
  setRate(settings.rate, false);
  await populateVoices();

  const resp = await sw({ type: 'ui-state' });
  state = resp?.state ?? null;
  renderPlayerState();

  playBtn.addEventListener('click', async () => {
    const active = state && state.tabId === tab.id;
    if (active && state.status === 'playing') {
      state = (await sw({ type: 'ui-pause' })).state;
    } else if (active && state.status === 'paused') {
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
    if (state && state.tabId === tab.id) await sw({ type: 'ui-set-voice', voice });
  });

  rateSel.addEventListener('change', () => setRate(Number(rateSel.value), true));
  rateDownBtn.addEventListener('click', () => setRate(settings.rate - 0.05, true));
  rateUpBtn.addEventListener('click', () => setRate(settings.rate + 0.05, true));

  // Keyboard while the popup has focus (the page's own handlers can't fire
  // then): Space toggles play/pause, ←/→ skip to the previous/next sentence.
  // Ignored when a dropdown/field is focused.
  document.addEventListener('keydown', async (e) => {
    const t = e.target;
    if (t && /^(SELECT|INPUT|TEXTAREA)$/.test(t.tagName)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      playBtn.click();
    } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && state && state.tabId === tab.id) {
      e.preventDefault();
      const resp = await sw({ type: 'ui-skip', delta: e.code === 'ArrowLeft' ? -1 : 1 });
      if (resp?.state) {
        state = resp.state;
        renderPlayerState();
      }
    }
  });

  // Live progress while the popup stays open.
  setInterval(async () => {
    const resp = await sw({ type: 'ui-state' }).catch(() => null);
    if (resp) {
      state = resp.state;
      renderPlayerState();
    }
  }, 1000);
}

// ---------- init ----------

async function init() {
  settings = await loadSettings();

  const override = new URLSearchParams(location.search).get('tabId');
  tab = override
    ? await chrome.tabs.get(Number(override))
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const url = tab?.url ?? '';

  if (looksLikePdf(url)) {
    openCurrentBtn.hidden = false;
    if (url.startsWith('file:')) {
      const allowed = await chrome.extension.isAllowedFileSchemeAccess();
      if (allowed) {
        openCurrentBtn.disabled = false;
      } else {
        fileAccessSection.hidden = false;
        currentHint.textContent = 'Local PDF detected — file access is not enabled yet.';
      }
    } else {
      openCurrentBtn.disabled = false;
    }
  } else if (isWebPage(url)) {
    await initPlayer();
  } else {
    currentHint.textContent = 'This page cannot be read (browser pages are off-limits to extensions).';
  }

  openCurrentBtn.addEventListener('click', async () => {
    await chrome.tabs.create({ url: readerUrl(`file=${encodeURIComponent(url)}`) });
    window.close();
  });

  openLocalBtn.addEventListener('click', async () => {
    await chrome.tabs.create({ url: readerUrl(null) });
    window.close();
  });

  openSettingsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  });
}

init();
