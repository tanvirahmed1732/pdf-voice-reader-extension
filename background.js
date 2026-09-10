// Service worker: routes messages between the side panel (controls), the content
// script (text extraction + on-page highlighting), and the offscreen document
// (TTS engines + audio), and tracks the single active reading session.

import { ensureEdgeTtsHeaders } from './tts/edge-dnr.js';

// Session rules vanish when the browser restarts — reinstall eagerly.
ensureEdgeTtsHeaders();
chrome.runtime.onInstalled.addListener(() => ensureEdgeTtsHeaders());
chrome.runtime.onStartup.addListener(() => ensureEdgeTtsHeaders());

// The controls live in a side panel (popup/popup.html) instead of a popup.
// It starts hidden; clicking the toolbar icon opens it, and clicking the icon
// again closes it. Chrome handles the toggle once this behavior is set.
function enableSidePanelToggle() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
enableSidePanelToggle();
chrome.runtime.onInstalled.addListener(enableSidePanelToggle);
chrome.runtime.onStartup.addListener(enableSidePanelToggle);

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
          // ←/→ pressed while the popup has focus.
          await skipSession(msg.delta);
          sendResponse({ state: session });
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
