// TtsEngine implementation over the Web Speech API (system/browser voices).
// One utterance per sentence; exact word highlighting via onboundary, with an
// estimated fallback for voices that never fire boundary events.

import { wordTokens, estimatedWordsPerSecond } from './engine.js';

function loadVoicesOnce() {
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

export class WebSpeechEngine {
  constructor() {
    this.rate = 1;
    this.voice = null;
    this.sentences = [];
    this.currentK = -1;
    this.sliceBase = 0; // sentence char offset where the current utterance's text begins
    this.lastBoundaryChar = 0; // absolute char offset (within sentence) of the last spoken word
    this.gen = 0; // generation guard: stale utterance events are ignored
    this.paused = false;
    this.speaking = false;
    this.startedAt = 0;
    this.pausedAccum = 0;
    this.pausedAt = 0;
    this.queued = new Map(); // k -> utterance (pre-enqueued and current, GC guard)

    this.noBoundaryTimer = null;
    this.estimator = null;
    this.watchdog = null;

    this.onSentenceStart = null;
    this.onSentenceEnd = null;
    this.onWordBoundary = null;
    this.onDone = null;
    this.onError = null;
  }

  async init() {
    await loadVoicesOnce();
  }

  async listVoices() {
    const voices = await loadVoicesOnce();
    const english = voices.filter((v) => v.lang?.toLowerCase().startsWith('en'));
    const rest = voices.filter((v) => !v.lang?.toLowerCase().startsWith('en'));
    return [...english, ...rest].map((v) => ({
      id: v.voiceURI,
      name: `${v.name} (${v.lang})`,
      lang: v.lang,
      kind: 'system',
    }));
  }

  async setVoice(id) {
    const voices = await loadVoicesOnce();
    this.voice = voices.find((v) => v.voiceURI === id) ?? null;
    if (this.speaking) this.#restartCurrent();
  }

  setRate(r) {
    this.rate = r;
    if (this.speaking) this.#restartCurrent();
  }

  speak(sentences, startIndex) {
    this.stop();
    this.sentences = sentences;
    if (startIndex >= sentences.length) {
      this.onDone?.();
      return;
    }
    this.speaking = true;
    this.#speakSentence(startIndex, 0);
    this.#startWatchdog();
  }

  pause() {
    if (!this.speaking || this.paused) return;
    this.paused = true;
    this.pausedAt = performance.now();
    speechSynthesis.pause();
  }

  resume() {
    if (!this.speaking || !this.paused) return;
    this.paused = false;
    if (this.pausedAt) this.pausedAccum += performance.now() - this.pausedAt;
    speechSynthesis.resume();
    // Some remote voices treat pause as stop — verify and recover.
    const gen = this.gen;
    setTimeout(() => {
      if (gen !== this.gen || this.paused || !this.speaking) return;
      if (!speechSynthesis.speaking && !speechSynthesis.pending) {
        this.#restartCurrent();
      }
    }, 300);
  }

  stop() {
    this.gen++;
    this.speaking = false;
    this.paused = false;
    this.queued.clear();
    this.#clearSentenceTimers();
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    speechSynthesis.cancel();
  }

  // ---------- internals ----------

  #restartCurrent() {
    if (this.currentK < 0) return;
    const k = this.currentK;
    const from = this.lastBoundaryChar;
    this.gen++;
    this.queued.clear();
    this.#clearSentenceTimers();
    speechSynthesis.cancel();
    // cancel() is async in Chrome; give it a beat before re-speaking.
    const gen = this.gen;
    setTimeout(() => {
      if (gen !== this.gen || !this.speaking) return;
      this.#speakSentence(k, from);
    }, 60);
  }

  #utteranceFor(k, fromChar) {
    const sentence = this.sentences[k];
    const text = sentence.text.slice(fromChar).replace(/\s/g, ' ');
    const utt = new SpeechSynthesisUtterance(text);
    if (this.voice) utt.voice = this.voice;
    utt.rate = this.rate;
    utt.lang = this.voice?.lang || 'en-US';
    return utt;
  }

  #speakSentence(k, fromChar) {
    const gen = this.gen;
    const utt = this.#utteranceFor(k, fromChar);
    this.queued.set(k, utt);
    this.#wireUtterance(utt, k, fromChar, gen);
    speechSynthesis.speak(utt);
  }

  #preEnqueue(k, gen) {
    if (gen !== this.gen || k >= this.sentences.length || this.queued.has(k)) return;
    const utt = this.#utteranceFor(k, 0);
    this.queued.set(k, utt);
    this.#wireUtterance(utt, k, 0, gen);
    speechSynthesis.speak(utt);
  }

  #wireUtterance(utt, k, fromChar, gen) {
    const tokens = wordTokens(utt.text);

    utt.onstart = () => {
      if (gen !== this.gen) return;
      this.currentK = k;
      this.sliceBase = fromChar;
      this.lastBoundaryChar = fromChar;
      this.startedAt = performance.now();
      this.pausedAccum = 0;
      this.pausedAt = 0;
      // Estimated word timings (no audio duration is known up front) so a
      // visible context can clock highlighting when onboundary won't fire
      // (e.g. the offscreen document used for in-page reading).
      const wps = estimatedWordsPerSecond(this.rate);
      const estTimings = tokens.map((t, i) => ({
        charStart: this.sliceBase + t.charStart,
        charLength: t.charLength,
        tStart: i / wps,
      }));
      this.onSentenceStart?.(k, estTimings);
      this.#armNoBoundaryFallback(k, tokens, gen);
      // Queue the next sentence so playback is gapless.
      this.#preEnqueue(k + 1, gen);
    };

    utt.onboundary = (e) => {
      if (gen !== this.gen || k !== this.currentK) return;
      if (e.name && e.name !== 'word') return;
      this.#clearSentenceTimers();
      const charStart = this.sliceBase + e.charIndex;
      let len = e.charLength;
      if (!len) {
        const tok = tokens.find((t) => t.charStart === e.charIndex);
        len = tok ? tok.charLength : 1;
      }
      this.lastBoundaryChar = charStart;
      this.onWordBoundary?.(k, charStart, len, true);
    };

    utt.onend = () => {
      if (gen !== this.gen) return;
      this.queued.delete(k);
      this.#clearSentenceTimers();
      this.onSentenceEnd?.(k);
      if (k + 1 >= this.sentences.length) {
        this.speaking = false;
        this.stop();
        this.onDone?.();
      } else if (!this.queued.has(k + 1)) {
        // Pre-enqueue missed (e.g. voice without reliable onstart) — chain manually.
        this.#speakSentence(k + 1, 0);
      }
    };

    utt.onerror = (e) => {
      if (gen !== this.gen) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      this.stop();
      this.onError?.(`Speech error: ${e.error}`);
    };
  }

  // If no boundary event arrives shortly after a sentence starts, the voice
  // doesn't support them — fall back to time-estimated word highlighting.
  #armNoBoundaryFallback(k, tokens, gen) {
    this.#clearSentenceTimers();
    this.noBoundaryTimer = setTimeout(() => {
      if (gen !== this.gen || k !== this.currentK || !tokens.length) return;
      const wps = estimatedWordsPerSecond(this.rate);
      this.estimator = setInterval(() => {
        if (gen !== this.gen || this.paused) return;
        const elapsed = (performance.now() - this.startedAt - this.pausedAccum) / 1000;
        const idx = Math.min(Math.floor(elapsed * wps), tokens.length - 1);
        const tok = tokens[idx];
        const charStart = this.sliceBase + tok.charStart;
        this.lastBoundaryChar = charStart;
        this.onWordBoundary?.(k, charStart, tok.charLength, false);
      }, 180);
    }, 700);
  }

  #clearSentenceTimers() {
    if (this.noBoundaryTimer) {
      clearTimeout(this.noBoundaryTimer);
      this.noBoundaryTimer = null;
    }
    if (this.estimator) {
      clearInterval(this.estimator);
      this.estimator = null;
    }
  }

  // Chrome mutes long utterances of remote voices after ~15s unless nudged.
  #startWatchdog() {
    this.watchdog = setInterval(() => {
      if (!this.speaking || this.paused) return;
      if (this.voice && this.voice.localService === false && speechSynthesis.speaking) {
        speechSynthesis.pause();
        speechSynthesis.resume();
      }
    }, 10000);
  }
}
