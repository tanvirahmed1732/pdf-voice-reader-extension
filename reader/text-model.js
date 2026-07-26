// DocTextModel: builds one global text string for the whole document from the
// PDF.js text content, segments it into sentences, and maps character offsets
// back to text-layer DOM nodes for highlighting and selection.

const MAX_SENTENCE_CHARS = 350;

export class DocTextModel {
  constructor() {
    this.docText = '';
    this.items = []; // flattened, sorted: {page, itemIndex, start, end}
    this.itemLookup = new Map(); // "page:itemIndex" -> item
    this.pageStart = []; // pageStart[p] = first global offset of page p
    this.sentences = []; // {start, end, text}
  }

  static async build(view, numPages, onProgress) {
    const model = new DocTextModel();
    const parts = [];
    let offset = 0;

    for (let p = 1; p <= numPages; p++) {
      onProgress?.(p, numPages);
      model.pageStart[p] = offset;
      const { items } = await view.getTextContent(p);

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let contrib = item.str ?? '';
        let sep = '';

        const next = items[i + 1];
        const h = item.height || 8;
        const dy = next ? Math.abs((next.transform?.[5] ?? 0) - (item.transform?.[5] ?? 0)) : 0;
        const lineBreak = item.hasEOL || dy > h * 0.5;

        if (lineBreak && next) {
          if (contrib.endsWith('-') && /^[a-z]/.test(next.str ?? '')) {
            // De-hyphenation: "exam-\nple" is spoken (and matched) as "example".
            contrib = contrib.slice(0, -1);
          } else if (dy > h * 1.8 || Math.abs((next.height || 8) - h) > h * 0.25) {
            // Real paragraph break: large vertical gap, or a font-size jump
            // (heading ↔ body text) — sentence boundary.
            sep = '\n';
          } else {
            // Line wrap inside a paragraph — must be a plain space: a newline
            // is a mandatory sentence break for Intl.Segmenter and a pause
            // for the TTS engines, which chops reading at every line end.
            sep = ' ';
          }
        }

        const rec = { page: p, itemIndex: i, start: offset, end: offset + contrib.length };
        model.items.push(rec);
        model.itemLookup.set(`${p}:${i}`, rec);
        parts.push(contrib);
        offset += contrib.length;
        if (sep) {
          parts.push(sep);
          offset += sep.length;
        }
      }

      parts.push('\n\n');
      offset += 2;
    }

    model.docText = parts.join('');
    model.#segmentSentences();
    return model;
  }

  #segmentSentences() {
    const text = this.docText;
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    const raw = [];
    for (const s of segmenter.segment(text)) {
      raw.push({ start: s.index, end: s.index + s.segment.length });
    }

    // Intl.Segmenter over-splits on abbreviations — merge those back together.
    const abbrev = /(?:\b(?:e\.g|i\.e|etc|vs|cf|Dr|Mr|Mrs|Ms|Prof|Fig|Figs|Eq|Eqs|No|Nos|al|Jr|Sr|St|ca|approx|Vol|Ch|Sec|pp)\.|\b[A-Z]\.)\s*$/;
    const merged = [];
    for (const seg of raw) {
      const prev = merged[merged.length - 1];
      if (prev && abbrev.test(text.slice(prev.start, prev.end))) {
        prev.end = seg.end;
      } else {
        merged.push(seg);
      }
    }

    // Trim whitespace, drop empties, and split monster segments (TOCs, tables)
    // so each TTS utterance stays a manageable size.
    const out = [];
    for (const seg of merged) {
      let { start, end } = seg;
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      if (start >= end) continue;

      while (end - start > MAX_SENTENCE_CHARS) {
        let cut = text.lastIndexOf(' ', start + MAX_SENTENCE_CHARS);
        if (cut <= start) cut = start + MAX_SENTENCE_CHARS;
        out.push({ start, end: cut, text: text.slice(start, cut) });
        start = cut;
        while (start < end && /\s/.test(text[start])) start++;
      }
      out.push({ start, end, text: text.slice(start, end) });
    }
    this.sentences = out;
  }

  get totalTextLength() {
    return this.sentences.reduce((n, s) => n + s.text.length, 0);
  }

  offsetToSentence(offset) {
    const s = this.sentences;
    if (!s.length) return 0;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].start <= offset) lo = mid;
      else hi = mid - 1;
    }
    // Clicking whitespace between sentences jumps to the next one.
    if (offset >= s[lo].end && lo + 1 < s.length) return lo + 1;
    return lo;
  }

  pageOfOffset(offset) {
    let page = 1;
    for (let p = 1; p < this.pageStart.length; p++) {
      if (this.pageStart[p] <= offset) page = p;
      else break;
    }
    return page;
  }

  pagesOfSentence(k) {
    const s = this.sentences[k];
    if (!s) return [];
    const first = this.pageOfOffset(s.start);
    const last = this.pageOfOffset(s.end - 1);
    const pages = [];
    for (let p = first; p <= last; p++) pages.push(p);
    return pages;
  }

  #firstItemIntersecting(start) {
    const items = this.items;
    let lo = 0;
    let hi = items.length - 1;
    let found = items.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].end > start) {
        found = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return found;
  }

  // DOM Ranges covering [start, end) — pages involved must be rendered already.
  rangesForSpan(start, end, view) {
    const ranges = [];
    for (let idx = this.#firstItemIntersecting(start); idx < this.items.length; idx++) {
      const item = this.items[idx];
      if (item.start >= end) break;
      if (item.end <= item.start) continue;
      const span = view.getSpan(item.page, item.itemIndex);
      const node = span?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;
      const from = Math.max(start, item.start) - item.start;
      const to = Math.min(end, item.end) - item.start;
      if (to <= from || to > node.length) continue;
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      ranges.push(range);
    }
    return ranges;
  }

  sentenceToDomRanges(k, view) {
    const s = this.sentences[k];
    return s ? this.rangesForSpan(s.start, s.end, view) : [];
  }

  firstElementOfSentence(k, view) {
    const s = this.sentences[k];
    if (!s) return null;
    const idx = this.#firstItemIntersecting(s.start);
    for (let i = idx; i < this.items.length; i++) {
      const item = this.items[i];
      if (item.start >= s.end) break;
      const span = view.getSpan(item.page, item.itemIndex);
      if (span) return span;
    }
    return null;
  }

  // Global offset for a DOM position inside a text-layer span, or null.
  offsetFromDomPosition(node, charOffset, view) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && !view.spanInfo(el)) el = el.parentElement;
    if (!el) return null;
    const { page, itemIndex } = view.spanInfo(el);
    const item = this.itemLookup.get(`${page}:${itemIndex}`);
    if (!item) return null;
    return Math.min(item.start + charOffset, Math.max(item.end - 1, item.start));
  }

  offsetFromSelection(view) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    return this.offsetFromDomPosition(range.startContainer, range.startOffset, view);
  }

  offsetFromPoint(x, y, view) {
    const range = document.caretRangeFromPoint(x, y);
    if (!range) return null;
    return this.offsetFromDomPosition(range.startContainer, range.startOffset, view);
  }
}
