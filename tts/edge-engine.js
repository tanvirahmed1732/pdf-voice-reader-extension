// TtsEngine implementation over the Microsoft Edge "Read Aloud" endpoint —
// the same Azure neural voices Edge's built-in reader uses. Free, needs
// internet. Returns MP3 audio plus exact word-boundary timestamps, so word
// highlighting is sample-accurate. One WebSocket per sentence; lookahead
// prefetch keeps playback gapless.

import { wordTokens } from './engine.js';
import { EDGE_VOICES } from './edge-voices.js';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const GEC_VERSION = '1-143.0.3650.75';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const ATTEMPT_TIMEOUT = 12000; // background preloads — generous, let slow synths finish
const URGENT_TIMEOUT = 10000; // attempts made while playback is waiting — bounded tighter
const STALL_REFRESH_MS = 6000; // a preload hung this long is replaced by a priority request
const MAX_RETRIES = 3; // retry so a transient failure recovers and the line is read
const CONCURRENCY = 3; // parallel synths — the offscreen network is slower, so more
// throughput helps build a lead; pacing (below) still avoids bursts that rate-limit
const CONN_GAP_MS = 350; // min spacing between new connections — a tight burst is what
// trips the rate limiter; pacing keeps requests gentle even while filling the lead.
const PRELOAD = 12; // sentences synthesized ahead of playback (a comfortable lead)
const CACHE_MAX = 26;
// Prefer READING every line over skipping it: a sentence that isn't ready is
// re-requested (a fresh retry cycle) until it synthesizes — playback waits
// instead of dropping the line. Only a sustained failure streak (a real
// outage) stops playback, with an error rather than a silent skip.
const MAX_CONSEC_FAIL = 4;
const CYCLE_COOLDOWN_MS = 600; // between re-request cycles — lets a rate limit cool down

// Text with no letters or digits (dot leaders, stray symbols) gets no audio
// from the service — filtered out before wasting a connection on it.
const SPEAKABLE_RE = /[\p{L}\p{N}]/u;

// Caps concurrent WebSocket connections AND paces their starts, so bursts don't
// trip the endpoint's rate limiter (the cause of the 403s / timeouts mid-read).
let activeConns = 0;
const connWaiters = [];
let lastConnStart = 0;
let recentFails = 0; // recent failures widen the gap below (adaptive back-off)
async function withConn(fn, urgent = false) {
  // Reserve the slot SYNCHRONOUSLY with the gate check (no await in between) —
  // otherwise many callers pass the gate before any increments and a burst of
  // connections opens at once, tripping the rate limiter. Urgent requests
  // (playback is waiting on them) bypass the cap entirely: a single extra
  // connection is not a burst, and a blocked sentence must never sit behind
  // long-running background preloads.
  if (!urgent) {
    while (activeConns >= CONCURRENCY) await new Promise((res) => connWaiters.push(res));
  }
  activeConns++;
  try {
    if (!urgent) {
      // When the endpoint has been failing, space new connections further
      // apart — hammering a tripped rate limiter turns one stall into a
      // cascade.
      const gapMs = CONN_GAP_MS * (1 + Math.min(recentFails, 4));
      const gap = gapMs - (Date.now() - lastConnStart);
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
    lastConnStart = Date.now();
    return await fn();
  } finally {
    activeConns--;
    connWaiters.shift()?.();
  }
}

// Resolves/rejects with `promise`, but rejects with 'not-ready' after `ms` so
// a hung background request can be replaced instead of waited out.
function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('not-ready')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// Retries a failed/timed-out synthesis with backoff, aborting early if the
// request became stale (user stopped, skipped, or changed rate/voice).
async function edgeSynthesizeRetry(text, voiceId, rate, isStale, urgent = false) {
  const timeout = urgent ? URGENT_TIMEOUT : ATTEMPT_TIMEOUT;
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (isStale()) throw new Error('stale');
    try {
      const result = await withConn(() => edgeSynthesize(text, voiceId, rate, timeout), urgent);
      recentFails = Math.max(0, recentFails - 1);
      return result;
    } catch (err) {
      lastErr = err;
      recentFails = Math.min(recentFails + 1, 8);
      if (isStale() || attempt === MAX_RETRIES - 1) break;
      // "No audio" is the service's answer for this text, not a glitch —
      // retrying the identical request just burns a connection slot.
      if (err.message === 'Edge voice returned no audio') break;
      // Brief backoff lets a transient rate-limit cool down before retrying.
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function uuid() {
  return crypto.randomUUID().replaceAll('-', '');
}

// Sec-MS-GEC DRM token: SHA-256 of (windows-file-time rounded to 5 min + token).
async function secMsGec() {
  let ticks = (BigInt(Math.floor(Date.now() / 1000)) + 11644473600n) * 10000000n;
  ticks -= ticks % 3000000000n;
  const data = new TextEncoder().encode(ticks.toString() + TRUSTED_CLIENT_TOKEN);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function escapeXml(s) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function ratePercent(rate) {
  const pct = Math.round((rate - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

function parseHeaders(str) {
  const headers = {};
  for (const line of str.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1);
  }
  return headers;
}

// Synthesize one sentence → {mp3: ArrayBuffer, words: [{tSec, text}]}
async function edgeSynthesize(text, voiceId, rate, timeoutMs) {
  const gec = await secMsGec();
  const url =
    `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${uuid()}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const chunks = [];
    const words = [];
    let settled = false;

    const fail = (message) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // already closed
      }
      reject(new Error(message));
    };

    const timeout = setTimeout(() => fail('Edge voice request timed out'), timeoutMs);

    ws.onopen = () => {
      const timestamp = new Date().toISOString();
      ws.send(
        `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
                  outputFormat: OUTPUT_FORMAT,
                },
              },
            },
          }),
      );
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${voiceId}'><prosody pitch='+0Hz' rate='${ratePercent(rate)}' volume='+0%'>` +
        escapeXml(text) +
        `</prosody></voice></speak>`;
      ws.send(
        `X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}\r\nPath:ssml\r\n\r\n${ssml}`,
      );
    };

    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const sep = e.data.indexOf('\r\n\r\n');
        const headers = parseHeaders(e.data.slice(0, sep));
        const body = e.data.slice(sep + 4);
        if (headers.Path === 'audio.metadata') {
          try {
            for (const item of JSON.parse(body).Metadata ?? []) {
              if (item.Type === 'WordBoundary') {
                words.push({ tSec: item.Data.Offset / 1e7, text: item.Data.text.Text });
              }
            }
          } catch {
            // metadata parse failure is non-fatal
          }
        } else if (headers.Path === 'turn.end') {
          settled = true;
          clearTimeout(timeout);
          ws.close();
          const total = chunks.reduce((n, c) => n + c.byteLength, 0);
          if (!total) {
            reject(new Error('Edge voice returned no audio'));
            return;
          }
          const mp3 = new Uint8Array(total);
          let pos = 0;
          for (const c of chunks) {
            mp3.set(new Uint8Array(c), pos);
            pos += c.byteLength;
          }
          resolve({ mp3: mp3.buffer, words });
        }
      } else {
        const view = new DataView(e.data);
        const headerLen = view.getUint16(0);
        const headers = parseHeaders(new TextDecoder().decode(e.data.slice(2, 2 + headerLen)));
        if (headers.Path === 'audio') chunks.push(e.data.slice(2 + headerLen));
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      fail('Could not reach the Edge voice service (check your internet connection)');
    };
    ws.onclose = () => {
      clearTimeout(timeout);
      if (!settled) fail('Edge voice connection closed unexpectedly');
    };
  });
}

// Align server word events with character positions in the sentence text.
function alignWords(text, words) {
  const tokens = wordTokens(text);
  const timings = [];
  let ptr = 0;
  let tokenIdx = 0;
  for (const w of words) {
    const found = text.indexOf(w.text, ptr);
    if (found !== -1) {
      timings.push({ charStart: found, charLength: w.text.length, tStart: w.tSec });
      ptr = found + w.text.length;
      while (tokenIdx < tokens.length && tokens[tokenIdx].charStart < ptr) tokenIdx++;
    } else if (tokenIdx < tokens.length) {
      const tok = tokens[tokenIdx++];
      timings.push({ charStart: tok.charStart, charLength: tok.charLength, tStart: w.tSec });
      ptr = tok.charStart + tok.charLength;
    }
  }
  return timings;
}

export class EdgeEngine {
  constructor() {
    this.rate = 1;
    this.voiceId = EDGE_VOICES[0].id;
    this.gen = 0;
    this.sentences = [];
    this.currentK = -1;
    // Playback uses an HTMLAudioElement, NOT the Web Audio API: in a hidden
    // offscreen document, AudioContext playback blocks concurrent WebSocket
    // connections (so synthesis of the next sentence stalls), whereas an
    // <audio> element does not.
    this.audio = null;
    this.currentUrl = null;
    this.raf = 0;
    this.cache = new Map(); // "k:rate" -> {promise: Promise<{mp3, timings}>, done}
    this.reqSeq = new Map(); // "k:rate" -> latest request sequence (bumping it cancels older retries)
    this.speaking = false;
    this.paused = false;
    this.consecFail = 0;

    this.onSentenceStart = null;
    this.onSentenceEnd = null;
    this.onWordBoundary = null;
    this.onNotice = null; // transient status (e.g. "reconnecting…")
    this.onDone = null;
    this.onError = null;
  }

  async init() {
    // In contexts with DNR access (reader page), make sure the header-rewrite
    // rule exists; the offscreen document relies on the service worker having
    // installed it (offscreen docs don't get the DNR API).
    try {
      const { ensureEdgeTtsHeaders } = await import('./edge-dnr.js');
      await ensureEdgeTtsHeaders();
    } catch {
      // no DNR in this context — rule installed by the background worker
    }
  }

  async listVoices() {
    return EDGE_VOICES.map((v) => ({ id: v.id, name: v.name, lang: 'en', kind: 'edge' }));
  }

  setVoice(id) {
    this.voiceId = id;
    this.cache.clear();
    this.reqSeq.clear();
  }

  setRate(r) {
    if (r === this.rate) return;
    this.rate = r;
    if (this.speaking) {
      const k = this.currentK;
      this.#stopPlayback();
      this.cache.clear();
      this.reqSeq.clear();
      this.#playSentence(k, ++this.gen);
    }
  }

  speak(sentences, startIndex) {
    const sameDoc = sentences === this.sentences;
    this.gen++;
    this.#stopPlayback();
    if (sameDoc) {
      // Keep already-synthesized audio (instant restart after a skip/jump);
      // drop pending requests — their retry chains die with the old generation.
      for (const [key, entry] of this.cache) {
        if (!entry.done) this.cache.delete(key);
      }
    } else {
      this.cache.clear();
      this.reqSeq.clear();
    }
    this.sentences = sentences;
    this.consecFail = 0;
    this.speaking = true;
    this.paused = false;
    this.#playSentence(startIndex, this.gen);
  }

  pause() {
    if (!this.speaking || this.paused) return;
    this.paused = true;
    this.audio?.pause();
  }

  resume() {
    if (!this.speaking || !this.paused) return;
    this.paused = false;
    this.audio?.play().catch(() => {});
  }

  stop() {
    this.gen++;
    this.speaking = false;
    this.paused = false;
    this.#stopPlayback();
    this.cache.clear();
    this.reqSeq.clear();
  }

  // ---------- internals ----------

  #stopPlayback() {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.audio) {
      this.audio.onended = null;
      try {
        this.audio.pause();
      } catch {
        // already stopped
      }
      this.audio = null;
    }
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
  }

  #getBuffer(k, gen, urgent = false) {
    const key = `${k}:${this.rate}`;
    const existing = this.cache.get(key);
    if (existing) return existing.promise;
    const text = this.sentences[k].text.replace(/\s/g, ' ');
    const seq = (this.reqSeq.get(key) ?? 0) + 1;
    this.reqSeq.set(key, seq);
    const stale = () => gen !== this.gen || this.reqSeq.get(key) !== seq;
    const entry = { done: false };
    entry.promise = edgeSynthesizeRetry(text, this.voiceId, this.rate, stale, urgent).then(({ mp3, words }) => {
      entry.done = true;
      return { mp3, timings: alignWords(this.sentences[k].text, words) };
    });
    entry.promise.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    this.cache.set(key, entry);
    if (this.cache.size > CACHE_MAX) {
      this.cache.delete(this.cache.keys().next().value);
    }
    return entry.promise;
  }

  // Cancel a sentence's in-flight retries and drop its cache entry, so the
  // next #getBuffer for it starts a completely fresh request.
  #abandon(k) {
    const key = `${k}:${this.rate}`;
    this.reqSeq.set(key, (this.reqSeq.get(key) ?? 0) + 1);
    this.cache.delete(key);
  }

  async #playSentence(k, gen, decodeRetries = 0) {
    if (gen !== this.gen) return;

    // Sentences with nothing pronounceable produce no audio — pass them
    // through instantly instead of spending a connection discovering that.
    while (k < this.sentences.length && !SPEAKABLE_RE.test(this.sentences[k].text)) {
      this.currentK = k;
      this.onSentenceStart?.(k, []);
      this.onSentenceEnd?.(k);
      k++;
    }
    if (k >= this.sentences.length) {
      this.speaking = false;
      this.onDone?.();
      return;
    }

    // Request the current sentence first (head of the connection queue), then
    // fill the lead so upcoming sentences synthesize (and retry) in the
    // background, never blocking playback.
    let wanted = this.#getBuffer(k, gen);
    for (let i = 1; i <= PRELOAD && k + i < this.sentences.length; i++) {
      if (SPEAKABLE_RE.test(this.sentences[k + i].text)) this.#getBuffer(k + i, gen).catch(() => {});
    }

    // Wait for the sentence, re-requesting from scratch on failure — a line is
    // never skipped. The "Buffering…" notice appears only when playback is
    // actually held up, not on a preload hit.
    let item;
    let noAudioTries = 0;
    let urgent = false;
    for (;;) {
      const noticeTimer = setTimeout(() => this.onNotice?.('Buffering…'), 1500);
      try {
        // A background preload hung past STALL_REFRESH_MS gets replaced by a
        // fresh priority request — usually done long before the hung attempt's
        // own timeout would even fire. Priority requests are self-bounded, so
        // they're awaited as-is.
        item = urgent ? await wanted : await withDeadline(wanted, STALL_REFRESH_MS);
        this.consecFail = 0;
        break;
      } catch (err) {
        if (gen !== this.gen) return;
        if (err.message === 'stale') return; // superseded by a newer request
        this.#abandon(k);
        if (err.message === 'not-ready') {
          // Not a service failure — just a hung request being replaced.
          urgent = true;
          wanted = this.#getBuffer(k, gen, true);
          continue;
        }
        if (err.message === 'Edge voice returned no audio' && ++noAudioTries >= 2) {
          // The service has nothing to say for this text (rare) — there is no
          // audio to lose, so moving on doesn't drop a spoken line.
          this.onSentenceEnd?.(k);
          this.#playSentence(k + 1, gen);
          return;
        }
        this.consecFail++;
        if (this.consecFail >= MAX_CONSEC_FAIL) {
          this.speaking = false;
          this.onError?.('Voice service is not responding (check your internet connection)');
          return;
        }
        // Brief cooldown, then synthesize this same sentence again.
        await new Promise((r) => setTimeout(r, CYCLE_COOLDOWN_MS));
        if (gen !== this.gen) return;
        urgent = true;
        wanted = this.#getBuffer(k, gen, true);
      } finally {
        clearTimeout(noticeTimer);
      }
    }
    if (gen !== this.gen) return;

    this.currentK = k;
    // Pass the exact word-timing table so a visible context (the content
    // script for in-page reading) can clock word highlighting.
    this.onSentenceStart?.(k, item.timings);

    // Clean up the previous sentence's audio/URL before starting this one.
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }

    const url = URL.createObjectURL(new Blob([item.mp3], { type: 'audio/mpeg' }));
    this.currentUrl = url;
    const audio = new Audio(url);
    this.audio = audio;
    audio.onended = () => {
      if (gen !== this.gen) return;
      if (this.audio === audio) this.audio = null; // a late resume() must not replay it
      this.onSentenceEnd?.(k);
      this.#playSentence(k + 1, gen);
    };
    // A corrupt/undecodable MP3 must not wedge playback: re-synthesize this
    // sentence once, and only then move past it.
    audio.onerror = () => {
      if (gen !== this.gen) return;
      this.#abandon(k);
      if (decodeRetries < 1) {
        this.#playSentence(k, gen, decodeRetries + 1);
      } else {
        this.onSentenceEnd?.(k);
        this.#playSentence(k + 1, gen);
      }
    };
    // If playback can't start (rare autoplay edge case), retry before giving
    // up on the line; and if the user paused while this sentence was
    // buffering, hold here — resume() starts the audio.
    const tryPlay = (attempt) => {
      audio.play().catch(() => {
        if (gen !== this.gen || this.paused) return;
        if (attempt < 3) setTimeout(() => gen === this.gen && !this.paused && tryPlay(attempt + 1), 250);
        else {
          this.onSentenceEnd?.(k);
          this.#playSentence(k + 1, gen);
        }
      });
    };
    if (!this.paused) tryPlay(1);

    // Exact word highlighting, clocked off the element's own playback position
    // (drives highlighting in the visible reader; the offscreen path relies on
    // the content script instead, since rAF doesn't run while hidden).
    const timings = item.timings;
    let idx = -1;
    let emitted = -1;
    const tick = () => {
      if (gen !== this.gen) return;
      const elapsed = audio.currentTime;
      while (idx + 1 < timings.length && timings[idx + 1].tStart <= elapsed) idx++;
      if (idx >= 0 && idx !== emitted) {
        emitted = idx;
        const t = timings[idx];
        this.onWordBoundary?.(k, t.charStart, t.charLength, true);
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
