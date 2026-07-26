// Renders PDF pages (canvas + selectable text layer) with lazy rendering.

import * as pdfjsLib from '../vendor/pdfjs/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');

export { pdfjsLib };

const RENDER_MARGIN = '1200px 0px';

export class PdfView {
  constructor(containerEl, pagesEl) {
    this.container = containerEl;
    this.pagesEl = pagesEl;
    this.pdfDoc = null;
    this.scale = 1;
    this.pageShells = []; // 1-based: {el, textLayerDiv, canvas, state, promise, textDivs}
    this.textContentCache = [];
    this.spanInfoMap = new WeakMap(); // span -> {page, itemIndex}
    this.onRelayout = null;
    this.onPageChange = null; // (pageNumber) => void
    this._pageRaf = 0;
    this._lastPage = 0;

    containerEl.addEventListener('scroll', () => this.#schedulePageUpdate(), { passive: true });

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.ensurePageRendered(Number(entry.target.dataset.page));
          }
        }
      },
      { root: containerEl, rootMargin: RENDER_MARGIN },
    );
  }

  async open(data) {
    this.pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    const firstPage = await this.pdfDoc.getPage(1);
    const baseViewport = firstPage.getViewport({ scale: 1 });
    const available = this.container.clientWidth - 32;
    this.scale = Math.min(Math.max(available / baseViewport.width, 0.5), 2);
    await this.#buildShells();
    return this.pdfDoc;
  }

  async #buildShells() {
    this.pagesEl.textContent = '';
    this.pageShells = [];
    // Must live on an ancestor of .page: the stylesheet derives
    // --total-scale-factor from it at the .page level.
    this.pagesEl.style.setProperty('--scale-factor', String(this.scale));
    for (let p = 1; p <= this.pdfDoc.numPages; p++) {
      const page = await this.pdfDoc.getPage(p);
      const viewport = page.getViewport({ scale: this.scale });

      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.page = String(p);
      el.style.width = `${viewport.width}px`;
      el.style.height = `${viewport.height}px`;

      const num = document.createElement('div');
      num.className = 'page-number';
      num.textContent = String(p);
      el.appendChild(num);

      this.pagesEl.appendChild(el);
      this.pageShells[p] = { el, state: 'none', promise: null, textDivs: null, textLayerDiv: null };
      this.observer.observe(el);
    }
  }

  async getTextContent(p) {
    if (!this.textContentCache[p]) {
      const page = await this.pdfDoc.getPage(p);
      this.textContentCache[p] = await page.getTextContent({ includeMarkedContent: false });
    }
    return this.textContentCache[p];
  }

  ensurePageRendered(p) {
    const shell = this.pageShells[p];
    if (!shell) return Promise.resolve();
    if (shell.state === 'done') return Promise.resolve();
    if (shell.state === 'rendering') return shell.promise;
    shell.state = 'rendering';
    shell.promise = this.#renderPage(p).then(
      () => {
        shell.state = 'done';
      },
      (err) => {
        shell.state = 'none';
        throw err;
      },
    );
    return shell.promise;
  }

  async #renderPage(p) {
    const shell = this.pageShells[p];
    const page = await this.pdfDoc.getPage(p);
    const viewport = page.getViewport({ scale: this.scale });

    const canvas = document.createElement('canvas');
    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext('2d');

    await page.render({
      canvasContext: ctx,
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
    }).promise;

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';

    const textContent = await this.getTextContent(p);
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
    });
    await textLayer.render();

    shell.el.appendChild(canvas);
    shell.el.appendChild(textLayerDiv);
    shell.textLayerDiv = textLayerDiv;
    shell.textDivs = textLayer.textDivs;

    for (let i = 0; i < textLayer.textDivs.length; i++) {
      this.spanInfoMap.set(textLayer.textDivs[i], { page: p, itemIndex: i });
    }
  }

  // The page currently occupying the top of the viewport.
  currentPage() {
    const cTop = this.container.getBoundingClientRect().top;
    const threshold = this.container.clientHeight * 0.35;
    let best = 1;
    for (let p = 1; p < this.pageShells.length; p++) {
      const el = this.pageShells[p]?.el;
      if (!el) continue;
      const top = el.getBoundingClientRect().top - cTop;
      if (top <= threshold) best = p;
      else break;
    }
    return best;
  }

  #schedulePageUpdate() {
    if (this._pageRaf) return;
    this._pageRaf = requestAnimationFrame(() => {
      this._pageRaf = 0;
      const p = this.currentPage();
      if (p !== this._lastPage) {
        this._lastPage = p;
        this.onPageChange?.(p);
      }
    });
  }

  scrollToPage(n) {
    const el = this.pageShells[n]?.el;
    if (!el) return;
    const cRect = this.container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    this.container.scrollTo({ top: this.container.scrollTop + (eRect.top - cRect.top) - 8, behavior: 'smooth' });
  }

  getSpan(p, itemIndex) {
    return this.pageShells[p]?.textDivs?.[itemIndex] ?? null;
  }

  spanInfo(span) {
    return this.spanInfoMap.get(span);
  }

  isPageRendered(p) {
    return this.pageShells[p]?.state === 'done';
  }

  async setZoom(factor) {
    const anchor = this.container.scrollTop / Math.max(this.container.scrollHeight, 1);
    this.scale = Math.min(Math.max(this.scale * factor, 0.3), 4);

    for (let p = 1; p < this.pageShells.length; p++) {
      const shell = this.pageShells[p];
      if (!shell) continue;
      this.observer.unobserve(shell.el);
    }
    await this.#buildShells();
    this.container.scrollTop = anchor * this.container.scrollHeight;
    this.onRelayout?.();
  }
}
