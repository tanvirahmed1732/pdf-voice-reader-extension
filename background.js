// Service worker: routes messages between the side panel (controls), the content
// script (text extraction + on-page highlighting), and the offscreen document
// (TTS engines + audio), and tracks the single active reading session.

import { ensureEdgeTtsHeaders } from './tts/edge-dnr.js';

// Session rules vanish when the browser restarts — reinstall eagerly.
ensureEdgeTtsHeaders();
chrome.runtime.onInstalled.addListener(() => ensureEdgeTtsHeaders());
chrome.runtime.onStartup.addListener(() => ensureEdgeTtsHeaders());

// ---------- sidebar ----------
//
// The controls (popup/popup.html) have three hosts, chosen by the persisted
// sidebarMode and cycled by the header button:
//   push / float — an in-page sidebar or floating window injected by
//                  content/sidebar.js (Chrome's own side panel can't shrink
//                  below ~320px; the in-page one resizes freely)
//   panel        — Chrome's built-in side panel; Chrome toggles it natively
//                  on icon clicks (openPanelOnActionClick)
// In push/float, tabs where scripts can't run (PDF viewer, chrome:// pages)
// fall back to Chrome's panel. Everything starts hidden; the icon toggles it,
// and while open the in-page sidebar follows the active tab across switches
// and navigations.

const SIDEBAR_KEY = 'sidebarOpen'; // chrome.storage.session — hidden again after a restart

async function sidebarMode() {
  const { sidebarMode } = await chrome.storage.local.get('sidebarMode');
  return sidebarMode === 'panel' || sidebarMode === 'float' ? sidebarMode : 'push';
}

// Chrome toggles its panel on icon clicks only in panel mode; otherwise we
// open it ourselves as the fallback.
async function applyPanelBehavior() {
  const panel = (await sidebarMode()) === 'panel';
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: panel }).catch(() => {});
}
applyPanelBehavior();
chrome.runtime.onInstalled.addListener(applyPanelBehavior);
chrome.runtime.onStartup.addListener(applyPanelBehavior);

function isWebPage(url) {
  try {
    const u = new URL(url ?? '');
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    return !u.pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

async function sidebarIsOpen() {
  return !!(await chrome.storage.session.get(SIDEBAR_KEY))[SIDEBAR_KEY];
}

async function showSidebar(tabId) {
  const { sidebarWidth, sidebarMode, sidebarFloat } = await chrome.storage.local.get([
    'sidebarWidth',
    'sidebarMode',
    'sidebarFloat',
  ]);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/sidebar.js'] });
    await chrome.tabs.sendMessage(tabId, {
      target: 'sidebar',
      type: 'show',
      tabId,
      width: sidebarWidth,
      mode: sidebarMode,
      float: sidebarFloat,
    });
    return true;
  } catch {
    return false; // page refuses scripts (store pages, etc.)
  }
}

function hideSidebar(tabId) {
  return chrome.tabs.sendMessage(tabId, { target: 'sidebar', type: 'hide' }).catch(() => {});
}

async function hideSidebarEverywhere() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((t) => isWebPage(t.url)).map((t) => hideSidebar(t.id)));
}

async function setSidebarOpen(open, tabId) {
  await chrome.storage.session.set({ [SIDEBAR_KEY]: open });
  if (open) {
    if (tabId != null) await showSidebar(tabId);
  } else {
    await hideSidebarEverywhere();
  }
}

async function toggleSidebar(tab) {
  const open = !(await sidebarIsOpen());
  await setSidebarOpen(open, tab.id);
  return open;
}

// Switch hosts. 'panel' comes from the in-page header button (its click is
// the user gesture Chrome requires to open the panel); 'push' comes from the
// button inside Chrome's panel, which then closes itself.
async function setSidebarMode(mode, { windowId } = {}) {
  if (mode === 'panel') {
    await chrome.storage.local.set({ sidebarMode: 'panel' });
    await chrome.storage.session.set({ [SIDEBAR_KEY]: false });
    await hideSidebarEverywhere();
    await applyPanelBehavior();
    if (windowId != null) await chrome.sidePanel.open({ windowId }).catch(() => {});
    return { ok: true };
  }
  await chrome.storage.local.set({ sidebarMode: mode === 'float' ? 'float' : 'push' });
  await applyPanelBehavior();
  const [tab] =
    windowId != null
      ? await chrome.tabs.query({ active: true, windowId })
      : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !isWebPage(tab.url)) {
    return { ok: false, error: 'Switch to a normal web page first — the in-page sidebar cannot open on this tab.' };
  }
  await setSidebarOpen(true, tab.id);
  return { ok: true };
}

chrome.action.onClicked.addListener(async (tab) => {
  if ((await sidebarMode()) === 'panel') return; // Chrome toggles its panel itself
  if (isWebPage(tab.url)) {
    await toggleSidebar(tab);
  } else {
    // PDF viewer / browser page: scripts can't run there, use Chrome's panel.
    await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

// Follow the user: an open sidebar appears on whichever web tab is active,
// and comes back after a navigation wipes the injected DOM.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!(await sidebarIsOpen())) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && isWebPage(tab.url)) showSidebar(tabId);
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.active || !isWebPage(tab.url)) return;
  if (await sidebarIsOpen()) showSidebar(tabId);
});

let session = null; // {tabId, status: 'playing'|'paused', k, total, note}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Plays text-to-speech audio for reading web pages aloud.',
  });
}

function sendOffscreen(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }).catch(() => {});
}

function sendContent(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, { ...msg, target: 'content' }).catch(() => {});
}

async function stopSession() {
  if (!session) return;
  const { tabId } = session;
  session = null;
  await sendOffscreen({ type: 'stop' });
  await sendContent(tabId, { type: 'hl-clear' });
}

async function pauseSession() {
  if (!session) return;
  session.status = 'paused';
  sendContent(session.tabId, { type: 'hl-pause' });
  await sendOffscreen({ type: 'pause' });
}

async function resumeSession() {
  if (!session) return;
  session.status = 'playing';
  sendContent(session.tabId, { type: 'hl-resume' });
  await sendOffscreen({ type: 'resume' });
}

// Restart reading at sentence k (also un-pauses, like the PDF reader's skip).
async function jumpSession(k) {
  if (!session) return;
  session.status = 'playing';
  session.k = k;
  sendContent(session.tabId, { type: 'hl-resume' });
  await sendOffscreen({ type: 'jump', k });
}

// Move by delta sentences, clamped to the document bounds.
async function skipSession(delta) {
  if (!session || session.status === 'error') return;
  const k = Math.min(Math.max(session.k + (delta | 0), 0), session.total - 1);
  await jumpSession(k);
}

async function handleUiPlay(msg, sendResponse) {
  const { tabId } = msg;
  if (session) await stopSession();

  // Ensure the Edge header-rewrite rule is installed BEFORE the offscreen makes
  // any WebSocket — otherwise the first synths 403 (no headers) until it lands.
  await ensureEdgeTtsHeaders();

  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
  const resp = await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'collect' });
  if (!resp || !resp.sentences?.length) {
    sendResponse({ error: 'No readable text found on this page.' });
    return;
  }

  await ensureOffscreen();
  session = { tabId, status: 'playing', k: resp.startIndex, total: resp.sentences.length, note: '' };
  await sendOffscreen({
    type: 'speak',
    sentences: resp.sentences,
    startIndex: resp.startIndex,
    voice: msg.voice,
    rate: msg.rate,
  });
  sendResponse({ ok: true, state: session });
}

function handleOffscreenEvent(ev) {
  if (!session) return;
  const { tabId } = session;
  if (ev.kind === 'sentence') {
    session.k = ev.k;
    session.note = '';
    sendContent(tabId, { type: 'hl-sentence', k: ev.k, timings: ev.timings });
  } else if (ev.kind === 'progress') {
    session.note = `Downloading voice… ${Math.round(ev.frac * 100)}%`;
  } else if (ev.kind === 'note') {
    session.note = ev.message;
  } else if (ev.kind === 'done') {
    sendContent(tabId, { type: 'hl-clear' });
    session = null;
  } else if (ev.kind === 'error') {
    sendContent(tabId, { type: 'hl-clear' });
    session = { ...session, status: 'error', note: ev.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'sw') return;
  (async () => {
    try {
      switch (msg.type) {
        case 'ui-play':
          await handleUiPlay(msg, sendResponse);
          break;
        case 'ui-pause':
          await pauseSession();
          sendResponse({ state: session });
          break;
        case 'ui-resume':
          await resumeSession();
          sendResponse({ state: session });
          break;
        case 'content-toggle':
          // Space pressed on the page — pause if playing, resume if paused.
          if (session && sender.tab && sender.tab.id === session.tabId) {
            if (session.status === 'paused') await resumeSession();
            else await pauseSession();
          }
          sendResponse({ state: session });
          break;
        case 'ui-stop':
          await stopSession();
          sendResponse({ state: null });
          break;
        case 'ui-state':
          sendResponse({ state: session });
          break;
        case 'ui-set-rate':
          await sendOffscreen({ type: 'set-rate', rate: msg.rate });
          sendResponse({});
          break;
        case 'ui-set-voice':
          await sendOffscreen({ type: 'set-voice', voice: msg.voice });
          sendResponse({});
          break;
        case 'off-event':
          handleOffscreenEvent(msg.event);
          sendResponse({});
          break;
        case 'content-jump':
          // Click-to-jump from the page: restart reading at the clicked sentence.
          if (session && sender.tab && sender.tab.id === session.tabId) await jumpSession(msg.k);
          sendResponse({});
          break;
        case 'content-skip':
          // ←/→ pressed on the page: previous / next sentence.
          if (session && sender.tab && sender.tab.id === session.tabId) await skipSession(msg.delta);
          sendResponse({ state: session });
          break;
        case 'ui-skip':
          // ←/→ pressed while the sidebar has focus.
          await skipSession(msg.delta);
          sendResponse({ state: session });
          break;
        case 'sidebar-close':
          // ✕ in the sidebar header.
          await setSidebarOpen(false);
          sendResponse({ open: false });
          break;
        case 'sidebar-toggle':
          // Same as clicking the toolbar icon on a web tab (used by tests).
          sendResponse({ open: await toggleSidebar(await chrome.tabs.get(msg.tabId)) });
          break;
        case 'sidebar-mode':
          sendResponse(await setSidebarMode(msg.mode, { windowId: msg.windowId ?? sender.tab?.windowId }));
          break;
        default:
          sendResponse({});
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }
  })();
  return true; // keep sendResponse alive across the async work
});

// Reading stops if its tab goes away or navigates.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId === tabId) stopSession();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (session?.tabId === tabId && changeInfo.url) stopSession();
});
