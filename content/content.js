// Content script for in-page reading: extracts the page's readable text
// (keeping a map back to the DOM text nodes), segments it into sentences,
// and paints sentence/word highlights while the offscreen document speaks.
// Injected on demand; self-contained (classic script, no module imports).

(() => {
  if (window.__pdfVoiceReader) return; // already injected — listener persists
  const S = (window.__pdfVoiceReader = {
    segs: [], // {node, start, end} — offsets into docText
    nodeSeg: new Map(), // text node -> its seg (for click-to-jump)
    docText: '',
    sentences: [], // {start, end, text}
    userScrolledAt: 0,
    active: false, // a read is in progress on this page
    // word-highlight clock (runs here, in the visible page)
    wordRaf: 0,
    clockT0: 0,
    pausedAt: 0,
    pausedAccum: 0,
  });

  const MAX_CHARS = 3000000;
  const MAX_SENTENCE_CHARS = 350;
  const BLOCK =
    'p,div,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre,article,section,aside,header,footer,figcaption,dd,dt,tr';

  // ---------- extraction ----------

  function extract() {
    const sel = window.getSelection();
    const range = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
    const selContainer = range ? range.startContainer : null;

    S.segs = [];
    S.nodeSeg = new Map();
    let text = '';
    let selStart = -1;
    let prevBlock = null;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        if (el.closest('script,style,noscript,textarea,select,svg,button,[aria-hidden="true"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (el.checkVisibility && !el.checkVisibility()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    while (walker.nextNode() && text.length < MAX_CHARS) {
      const node = walker.currentNode;
      const block = node.parentElement.closest(BLOCK) || document.body;
      if (prevBlock && block !== prevBlock) text += '\n';
      prevBlock = block;

      if (selStart === -1 && selContainer) {
        if (node === selContainer) {
          selStart = text.length + range.startOffset;
        } else if (
          selContainer.nodeType === Node.ELEMENT_NODE &&
          selContainer.contains(node) &&
          range.comparePoint(node, 0) >= 0
        ) {
          selStart = text.length;
        }
      }

      const seg = { node, start: text.length, end: text.length + node.nodeValue.length };
      S.segs.push(seg);
      S.nodeSeg.set(node, seg);
      // Newlines/tabs inside a node become spaces 1:1 (offsets preserved) —
      // raw newlines would force sentence breaks and TTS pauses mid-paragraph.
      text += node.nodeValue.replace(/\s/g, ' ');
    }

    S.docText = text;
    return selStart;
  }

  // ---------- sentence segmentation (mirrors reader/text-model.js) ----------

  function segmentSentences() {
    const text = S.docText;
    const raw = [];
    for (const s of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)) {
      raw.push({ start: s.index, end: s.index + s.segment.length });
    }

    const abbrev = /(?:\b(?:e\.g|i\.e|etc|vs|cf|Dr|Mr|Mrs|Ms|Prof|Fig|Figs|Eq|Eqs|No|Nos|al|Jr|Sr|St|ca|approx|Vol|Ch|Sec|pp)\.|\b[A-Z]\.)\s*$/;
    const merged = [];
    for (const seg of raw) {
      const prev = merged[merged.length - 1];
      if (prev && abbrev.test(text.slice(prev.start, prev.end))) prev.end = seg.end;
      else merged.push(seg);
    }

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
    S.sentences = out;
  }

  function offsetToSentence(offset) {
    const s = S.sentences;
    if (!s.length) return 0;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].start <= offset) lo = mid;
      else hi = mid - 1;
    }
    if (offset >= s[lo].end && lo + 1 < s.length) return lo + 1;
    return lo;
  }

  // ---------- highlighting ----------

  function rangesFor(start, end) {
    const segs = S.segs;
    let lo = 0;
    let hi = segs.length - 1;
    let first = segs.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].end > start) {
        first = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    const ranges = [];
    for (let i = first; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.start >= end) break;
      if (!seg.node.isConnected) continue;
      const from = Math.max(start, seg.start) - seg.start;
      const to = Math.min(end, seg.end) - seg.start;
      if (to <= from || to > seg.node.length) continue;
      const range = document.createRange();
      range.setStart(seg.node, from);
      range.setEnd(seg.node, to);
      ranges.push(range);
    }
    return ranges;
  }

  function setHighlight(name, ranges) {
    if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
    else CSS.highlights.delete(name);
  }

  // Nearest scrollable ancestor (many sites scroll a container, not the
  // window — window.scrollBy would silently do nothing on those).
  function scroller(el) {
    for (let n = el && el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(s.overflowY + ' ' + s.overflow) && n.scrollHeight > n.clientHeight + 4) {
        return n;
      }
    }
    return null;
  }

  // Snap-to-top: once the reading sentence crosses the middle of the screen
  // (or leaves the viewport), scroll it back up to near the top.
  function autoScroll(ranges) {
    if (!ranges.length) return;
    if (performance.now() - S.userScrolledAt < 4000) return;
    const rect = ranges[0].getBoundingClientRect();
    const vh = window.innerHeight;
    const topZone = vh * 0.15;
    if (!(rect.top > vh * 0.5 || rect.top < 0 || rect.bottom > vh)) return;
    const node = ranges[0].startContainer.parentElement;
    const sc = scroller(node);
    if (sc) {
      const scRect = sc.getBoundingClientRect();
      sc.scrollBy({ top: rect.top - scRect.top - topZone, behavior: 'smooth' });
    } else {
      window.scrollBy({ top: rect.top - topZone, behavior: 'smooth' });
    }
  }

  // Global offset for a DOM position (from caretRangeFromPoint), or null.
  function offsetFromNode(node, offset) {
    let n = node;
    if (n && n.nodeType !== Node.TEXT_NODE) {
      const child = n.childNodes[offset] || n.firstChild;
      n = child && child.nodeType === Node.TEXT_NODE ? child : null;
      offset = 0;
    }
    const seg = n && S.nodeSeg.get(n);
    return seg ? seg.start + Math.min(offset, seg.node.length) : null;
  }

  function clearHighlights() {
    stopWordClock();
    CSS.highlights.delete('pdfvr-sentence');
    CSS.highlights.delete('pdfvr-word');
  }

  // ---------- word-highlight clock (runs in this visible page) ----------

  function stopWordClock() {
    if (S.wordRaf) {
      cancelAnimationFrame(S.wordRaf);
      S.wordRaf = 0;
    }
  }

  // Advances the per-word highlight in sync with the audio playing in the
  // offscreen document. timings: [{charStart, charLength, tStart}] with tStart
  // in seconds from the sentence's audio start; we anchor to message arrival.
  function startWordClock(k, timings) {
    stopWordClock();
    const s = S.sentences[k];
    if (!s || !timings || !timings.length) return;
    S.clockT0 = performance.now();
    S.pausedAt = 0;
    S.pausedAccum = 0;
    let idx = -1;
    let emitted = -1;
    const tick = () => {
      const now = performance.now();
      const pausedSoFar = S.pausedAccum + (S.pausedAt ? now - S.pausedAt : 0);
      const elapsed = (now - S.clockT0 - pausedSoFar) / 1000;
      while (idx + 1 < timings.length && timings[idx + 1].tStart <= elapsed) idx++;
      if (idx >= 0 && idx !== emitted) {
        emitted = idx;
        const t = timings[idx];
        const start = s.start + t.charStart;
        setHighlight('pdfvr-word', rangesFor(start, start + (t.charLength || 1)));
      }
      S.wordRaf = requestAnimationFrame(tick);
    };
    S.wordRaf = requestAnimationFrame(tick);
  }

  const style = document.createElement('style');
  style.textContent = `
    ::highlight(pdfvr-sentence) { background-color: rgba(255, 213, 0, 0.22); }
    ::highlight(pdfvr-word) { background-color: rgba(255, 130, 0, 0.35); }
  `;
  document.documentElement.appendChild(style);

  for (const evt of ['wheel', 'touchmove']) {
    window.addEventListener(evt, () => (S.userScrolledAt = performance.now()), { passive: true });
  }

  // Space toggles pause/resume while reading (same as the PDF reader). Ignored
  // when typing in a field; prevents the default page-scroll so it doesn't fight.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!S.active || e.code !== 'Space') return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      chrome.runtime.sendMessage({ target: 'sw', type: 'content-toggle' });
    },
    true,
  );

  // Click-to-jump: while reading, click anywhere in the text to move the
  // reading position there (same as the PDF reader). Ignores clicks on links
  // and controls, and never fires while the user is selecting text.
  document.addEventListener(
    'click',
    (e) => {
      if (!S.active) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      if (
        e.target.closest &&
        e.target.closest('a,button,input,select,textarea,label,[role="button"],[contenteditable]')
      ) {
        return;
      }
      const range = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (!range) return;
      const off = offsetFromNode(range.startContainer, range.startOffset);
      if (off == null) return;
      chrome.runtime.sendMessage({ target: 'sw', type: 'content-jump', k: offsetToSentence(off) });
    },
    true,
  );

  // ---------- messaging ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== 'content') return;
    switch (msg.type) {
      case 'collect': {
        const selStart = extract();
        segmentSentences();
        sendResponse({
          sentences: S.sentences.map((s) => ({ start: s.start, end: s.end, text: s.text })),
          startIndex: selStart >= 0 ? offsetToSentence(selStart) : 0,
        });
        break;
      }
      case 'hl-sentence': {
        S.active = true;
        const s = S.sentences[msg.k];
        if (!s) break;
        const ranges = rangesFor(s.start, s.end);
        setHighlight('pdfvr-sentence', ranges);
        autoScroll(ranges);
        startWordClock(msg.k, msg.timings);
        break;
      }
      case 'hl-pause':
        if (!S.pausedAt) S.pausedAt = performance.now();
        break;
      case 'hl-resume':
        if (S.pausedAt) {
          S.pausedAccum += performance.now() - S.pausedAt;
          S.pausedAt = 0;
        }
        break;
      case 'hl-clear':
        S.active = false;
        clearHighlights();
        break;
    }
  });
})();
