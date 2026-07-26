// Engine-agnostic playback controller: owns the sentence cursor, drives the
// active TTS engine, and forwards engine events to the highlighter and UI.

export const PlayerState = {
  IDLE: 'idle',
  PLAYING: 'playing',
  PAUSED: 'paused',
};

export class Player {
  constructor(model, highlighter) {
    this.model = model;
    this.highlighter = highlighter;
    this.engine = null;
    this.state = PlayerState.IDLE;
    this.currentK = 0;
    this.onStateChange = null; // (state) => void
    this.onProgress = null; // (k, page) => void
    this.onError = null; // (message) => void
  }

  setEngine(engine) {
    const wasPlaying = this.state === PlayerState.PLAYING || this.state === PlayerState.PAUSED;
    const k = this.currentK;
    if (this.engine) this.engine.stop();

    this.engine = engine;
    engine.onSentenceStart = (idx) => {
      this.currentK = idx;
      this.highlighter.setSentence(idx);
      this.onProgress?.(idx, this.model.pageOfOffset(this.model.sentences[idx].start));
    };
    engine.onSentenceEnd = () => {};
    engine.onWordBoundary = (idx, charStart, charLength) => {
      const sentence = this.model.sentences[idx];
      if (!sentence) return;
      this.highlighter.setWord(sentence.start + charStart, charLength);
    };
    engine.onDone = () => {
      this.#setState(PlayerState.IDLE);
      this.highlighter.clear();
    };
    engine.onError = (message) => {
      this.#setState(PlayerState.IDLE);
      this.highlighter.clear();
      this.onError?.(message);
    };

    if (wasPlaying) this.playFrom(k);
  }

  #setState(s) {
    this.state = s;
    this.onStateChange?.(s);
  }

  playFrom(k) {
    if (!this.engine || !this.model.sentences.length) return;
    const idx = Math.min(Math.max(k, 0), this.model.sentences.length - 1);
    this.currentK = idx;
    this.engine.speak(this.model.sentences, idx);
    this.#setState(PlayerState.PLAYING);
  }

  playFromOffset(globalOffset) {
    this.playFrom(this.model.offsetToSentence(globalOffset));
  }

  toggle() {
    if (this.state === PlayerState.PLAYING) {
      this.engine.pause();
      this.#setState(PlayerState.PAUSED);
    } else if (this.state === PlayerState.PAUSED) {
      this.engine.resume();
      this.#setState(PlayerState.PLAYING);
    }
  }

  stop() {
    this.engine?.stop();
    this.#setState(PlayerState.IDLE);
    this.highlighter.clear();
  }

  skip(delta) {
    if (this.state === PlayerState.IDLE) return;
    const k = Math.min(Math.max(this.currentK + delta, 0), this.model.sentences.length - 1);
    this.playFrom(k);
  }

  jumpTo(k) {
    if (this.state === PlayerState.IDLE) return;
    this.playFrom(k);
  }

  setRate(r) {
    this.engine?.setRate(r);
  }

  get isActive() {
    return this.state !== PlayerState.IDLE;
  }
}
