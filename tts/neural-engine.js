// TtsEngine implementation for local neural voices (Piper, in a worker).
// Playback via Web Audio; word highlighting is estimated from the exact
// per-sentence audio duration.

import { estimateWordTimings } from './engine.js';

// Large lead buffer so synthesis (slower on weak CPUs) stays well ahead of
// playback and never causes a mid-read pause.
const LOOKAHEAD = 6;
const CACHE_MAX = 20;

export class NeuralEngine {
  constructor() {
    this.rate = 1;
    this.voiceId = null;
    this.worker = null;
    this.audioCtx = null;
    this.gen = 0;
    this.sentences = [];
    this.currentK = -1;
    this.source = null;
    this.raf = 0;
    this.cache = new Map(); // "k:rate" -> Promise<AudioBuffer>
    this.pendingReqs = new Map(); // reqId -> {resolve, reject}
    this.reqCounter = 0;
    this.speaking = false;
    this.paused = false;

    this.onSentenceStart = null;
    this.onSentenceEnd = null;
    this.onWordBoundary = null;
    this.onDone = null;
    this.onError = null;
    this.onVoiceProgress = null; // (frac) — model download progress
  }

  async init() {
    this.audioCtx = new AudioContext();
  }

  #ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(chrome.runtime.getURL('tts/neural-worker.js'), { type: 'module' });
    this.worker.onmessage = (e) => {
      const msg = e.data;
      const req = this.pendingReqs.get(msg.reqId);
      if (msg.type === 'progress') {
        this.onVoiceProgress?.(msg.frac);
      } else if (msg.type === 'ready') {
        req?.resolve();
        this.pendingReqs.delete(msg.reqId);
      } else if (msg.type === 'audio') {
        req?.resolve(msg);
        this.pendingReqs.delete(msg.reqId);
      } else if (msg.type === 'error') {
        req?.reject(new Error(msg.message));
        this.pendingReqs.delete(msg.reqId);
      }
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Neural TTS worker failed');
      for (const req of this.pendingReqs.values()) req.reject(err);
      this.pendingReqs.clear();
    };
  }

  #request(payload, transfer = []) {
    this.#ensureWorker();
    const reqId = ++this.reqCounter;
    return new Promise((resolve, reject) => {
      this.pendingReqs.set(reqId, { resolve, reject });
      this.worker.postMessage({ ...payload, reqId }, transfer);
    });
  }

  async listVoices() {
    return []; // the voice catalog UI owns neural voice listing
  }

  async setVoice(voiceId) {
    this.#ensureWorker();
    await this.#request({
      type: 'init',
      voiceId,
      wasmRoot: chrome.runtime.getURL('vendor/piper/'),
    });
    this.voiceId = voiceId;
    this.cache.clear();
  }

  setRate(r) {
    if (r === this.rate) return;
    this.rate = r;
    if (this.speaking) {
      const k = this.currentK;
      this.#stopPlayback();
      this.worker?.postMessage({ type: 'cancelAll' }); // old-rate synths are useless now
      this.cache.clear();
      this.#playSentence(k, ++this.gen);
    }
  }

  speak(sentences, startIndex) {
    this.stop();
    this.sentences = sentences;
    this.speaking = true;
    this.paused = false;
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    this.#playSentence(startIndex, ++this.gen);
  }

  pause() {
    if (!this.speaking || this.paused) return;
    this.paused = true;
    this.audioCtx.suspend();
  }

  resume() {
    if (!this.speaking || !this.paused) return;
    this.paused = false;
    this.audioCtx.resume();
  }

  stop() {
    this.gen++;
    this.speaking = false;
    this.paused = false;
    this.#stopPlayback();
    this.worker?.postMessage({ type: 'cancelAll' });
    this.cache.clear();
    if (this.audioCtx?.state === 'suspended') this.audioCtx.resume();
  }

  // ---------- internals ----------

  #stopPlayback() {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // already stopped
      }
      this.source = null;
    }
  }

  #getBuffer(k, gen) {
    const key = `${k}:${this.rate}`;
    if (this.cache.has(key)) return this.cache.get(key);
    // Whitespace → plain spaces (1:1, so word-timing offsets stay aligned);
    // espeak pauses on newline characters.
    const speakText = this.sentences[k].text.replace(/\s/g, ' ');
    const promise = this.#request({ type: 'synth', text: speakText, rate: this.rate }).then(
      (msg) => {
        const buffer = this.audioCtx.createBuffer(1, msg.pcm.length, msg.sampleRate);
        buffer.copyToChannel(msg.pcm, 0);
        return buffer;
      },
    );
    promise.catch(() => this.cache.delete(key));
    this.cache.set(key, promise);
    // Simple LRU cap.
    if (this.cache.size > CACHE_MAX) {
      this.cache.delete(this.cache.keys().next().value);
    }
    return promise;
  }

  async #playSentence(k, gen) {
    if (gen !== this.gen) return;
    if (k >= this.sentences.length) {
      this.speaking = false;
      this.onDone?.();
      return;
    }

    let buffer;
    try {
      buffer = await this.#getBuffer(k, gen);
    } catch (err) {
      if (gen !== this.gen || err.message === 'canceled') return;
      this.speaking = false;
      this.onError?.(`Neural voice error: ${err.message}`);
      return;
    }
    if (gen !== this.gen) return;

    // Prefetch upcoming sentences while this one plays.
    for (let i = 1; i <= LOOKAHEAD && k + i < this.sentences.length; i++) {
      this.#getBuffer(k + i, gen).catch(() => {});
    }

    // Estimated word timings (exact sentence duration → proportional words).
    const timings = estimateWordTimings(this.sentences[k].text, buffer.duration);

    this.currentK = k;
    this.onSentenceStart?.(k, timings);

    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioCtx.destination);
    this.source = source;
    const startTime = this.audioCtx.currentTime;
    source.onended = () => {
      if (gen !== this.gen) return;
      this.onSentenceEnd?.(k);
      this.#playSentence(k + 1, gen);
    };
    source.start();

    // Estimated word highlighting driven by the audio clock (freezes on suspend).
    let idx = -1;
    let emitted = -1;
    const tick = () => {
      if (gen !== this.gen) return;
      const elapsed = this.audioCtx.currentTime - startTime;
      while (idx + 1 < timings.length && timings[idx + 1].tStart <= elapsed) idx++;
      if (idx >= 0 && idx !== emitted) {
        emitted = idx;
        const t = timings[idx];
        this.onWordBoundary?.(k, t.charStart, t.charLength, false);
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
