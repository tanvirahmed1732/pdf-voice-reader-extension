// Live TTS highlighting via the CSS Custom Highlight API — no DOM mutation,
// so user selection and offset mappings stay intact. Also owns auto-scroll.

const SCROLL_SUPPRESS_MS = 4000;

export class Highlighter {
  constructor(model, view, containerEl, pillEl) {
    this.model = model;
    this.view = view;
    this.container = containerEl;
    this.pill = pillEl;
    this.currentSentence = -1;
    this.currentWord = null; // {offset, length}
    this.userScrolledAt = 0;

    for (const evt of ['wheel', 'touchmove']) {
      containerEl.addEventListener(evt, () => this.#noteUserScroll(), { passive: true });
    }
    pillEl.addEventListener('click', () => {
      this.userScrolledAt = 0;
      pillEl.hidden = true;
      if (this.currentSentence >= 0) this.#autoScroll(this.currentSentence, true);
    });
  }

  #noteUserScroll() {
    this.userScrolledAt = performance.now();
    if (this.currentSentence >= 0) this.pill.hidden = false;
  }

  async setSentence(k) {
    this.currentSentence = k;
    for (const p of this.model.pagesOfSentence(k)) {
      await this.view.ensurePageRendered(p);
    }
    if (this.currentSentence !== k) return; // superseded while awaiting render
    const ranges = this.model.sentenceToDomRanges(k, this.view);
    if (ranges.length) {
      CSS.highlights.set('tts-sentence', new Highlight(...ranges));
    } else {
      CSS.highlights.delete('tts-sentence');
    }
    this.#autoScroll(k, false);
  }

  setWord(globalOffset, length) {
    this.currentWord = { offset: globalOffset, length };
    const ranges = this.model.rangesForSpan(globalOffset, globalOffset + length, this.view);
    if (ranges.length) {
      CSS.highlights.set('tts-word', new Highlight(...ranges));
    } else {
      CSS.highlights.delete('tts-word');
    }
  }

  clear() {
    this.currentSentence = -1;
    this.currentWord = null;
    CSS.highlights.delete('tts-sentence');
    CSS.highlights.delete('tts-word');
    this.pill.hidden = true;
  }

  // After zoom/relayout the spans were recreated — rebuild current highlights.
  async refresh() {
    const k = this.currentSentence;
    const word = this.currentWord;
    if (k >= 0) await this.setSentence(k);
    if (word) this.setWord(word.offset, word.length);
  }

  // Snap-to-top: the reading sentence flows down from the top; once it
  // crosses the middle of the viewport (or scrolls out of view), scroll it
  // back up to near the top so it has room to read down again.
  #autoScroll(k, force) {
    if (!force && performance.now() - this.userScrolledAt < SCROLL_SUPPRESS_MS) return;
    const el = this.model.firstElementOfSentence(k, this.view);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const box = this.container.getBoundingClientRect();
    const relTop = rect.top - box.top; // position within the scroll viewport
    const middle = box.height * 0.5;
    const topZone = box.height * 0.15;
    if (force || relTop > middle || relTop < 0 || rect.bottom > box.bottom) {
      this.container.scrollBy({ top: relTop - topZone, behavior: 'smooth' });
    }
    if (!force) this.pill.hidden = true;
  }
}
