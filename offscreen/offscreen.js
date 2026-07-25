// Offscreen document: hosts the TTS engines (system + neural) for in-page
// web reading. Audio plays from here while the user stays on their page;
// sentence/word events are relayed to the content script for highlighting.

import { WebSpeechEngine } from '../tts/webspeech-engine.js';

const engines = {}; // kind -> engine
let engine = null;
let engineKind = null;
let sentences = [];
let currentK = 0;
let playing = false;

function post(event) {
  chrome.runtime.sendMessage({ target: 'sw', type: 'off-event', event }).catch(() => {});
}

// Keep-alive: a hidden offscreen document is network-throttled the moment it
// stops producing audio (the silent gaps between sentences) — which slows the
// next WebSocket synthesis, causing longer gaps in a vicious cycle. A
// continuous, essentially-silent looping <audio> keeps the document "playing
// audio" the whole session, so synthesis stays fast. (Uses HTMLAudio, not Web
// Audio: AudioContext playback blocks WebSockets in the offscreen.)
function silentWavUri(seconds = 1, sampleRate = 8000) {
  const n = Math.floor(seconds * sampleRate);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true); // samples remain 0 (silence)
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(bin)}`;
}
let kaAudio = null;
const SILENT_WAV = silentWavUri();
function startKeepAlive() {
  if (kaAudio) return;
  kaAudio = new Audio(SILENT_WAV);
  kaAudio.loop = true;
  kaAudio.volume = 0.02; // inaudible but a real signal
  kaAudio.play().catch(() => {});
}
function stopKeepAlive() {
  if (kaAudio) {
    try {
      kaAudio.pause();
    } catch {
      // ignore
    }
    kaAudio = null;
  }
}

async function getEngine(kind) {
  if (engines[kind]) return engines[kind];
  let e;
  if (kind === 'neural') {
    const { NeuralEngine } = await import('../tts/neural-engine.js');
    e = new NeuralEngine();
    e.onVoiceProgress = (frac) => post({ kind: 'progress', frac });
  } else if (kind === 'edge') {
    const { EdgeEngine } = await import('../tts/edge-engine.js');
    e = new EdgeEngine();
  } else {
    e = new WebSpeechEngine();
  }
  await e.init();
  e.onSentenceStart = (k, timings) => {
    currentK = k;
    // Word highlighting is clocked by the content script (visible page); the
    // offscreen document's own rAF/boundary clocks don't fire while hidden.
    post({ kind: 'sentence', k, timings: timings || null });
  };
  e.onSentenceEnd = () => {};
  e.onNotice = (message) => post({ kind: 'note', message });
  e.onDone = () => {
    playing = false;
    stopKeepAlive();
    post({ kind: 'done' });
  };
  e.onError = (message) => {
    // The Edge engine already retries and skips isolated failures, keeping the
    // chosen voice; this fires only on a real outage. Stop with a message
    // rather than silently switching the voice out from under the user.
    playing = false;
    stopKeepAlive();
    post({ kind: 'error', message });
  };
  engines[kind] = e;
  return e;
}

async function activate(voice) {
  const kind = ['neural', 'edge'].includes(voice?.kind) ? voice.kind : 'system';
  const next = await getEngine(kind);
  if (engine && engine !== next) engine.stop();
  engine = next;
  engineKind = kind;
  if (voice?.id) await engine.setVoice(voice.id);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  (async () => {
    try {
      switch (msg.type) {
        case 'speak':
          sentences = msg.sentences;
          currentK = msg.startIndex;
          await activate(msg.voice);
          engine.setRate(msg.rate || 1);
          playing = true;
          startKeepAlive();
          engine.speak(sentences, msg.startIndex);
          break;
        case 'jump':
          if (engine && sentences.length) {
            currentK = msg.k;
            playing = true;
            startKeepAlive();
            engine.speak(sentences, msg.k);
          }
          break;
        case 'pause':
          engine?.pause();
          break;
        case 'resume':
          engine?.resume();
          break;
        case 'stop':
          playing = false;
          stopKeepAlive();
          engine?.stop();
          break;
        case 'set-rate':
          engine?.setRate(msg.rate);
          break;
        case 'set-voice': {
          const k = currentK;
          const wasPlaying = playing;
          engine?.stop();
          await activate(msg.voice);
          if (wasPlaying && sentences.length) engine.speak(sentences, k);
          break;
        }
      }
      sendResponse({});
    } catch (err) {
      post({ kind: 'error', message: err.message });
      sendResponse({ error: err.message });
    }
  })();
  return true;
});
