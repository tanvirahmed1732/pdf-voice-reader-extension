// In-page sidebar: hosts the controls page (popup/popup.html) in an iframe on
// the right edge of a web page, with a drag handle for any width. Replaces
// Chrome's built-in side panel on web pages because that panel cannot shrink
// below ~320px. Injected on demand by the service worker; classic script.
//
// Layout modes (persisted in chrome.storage.local as sidebarMode; the header
// button cycles push → float → overlay → push):
//   push    — sidebar; the page is narrowed so nothing sits behind it
//   float   — a floating window: drag by its header, resize from its left
//             edge, bottom edge or bottom-left corner (geometry in sidebarFloat)
//   overlay — sidebar floating above the page
// Sidebar width is persisted as sidebarWidth. Both are mirrored live into
// other tabs.

(() => {
  if (window.__pdfVoiceReaderSidebar) return; // already injected — listener persists

  const MIN_WIDTH = 44; // just the close button and drag grip
  const MIN_HEIGHT = 120;
  const MAX_FRACTION = 0.9; // of the viewport
  const DEFAULT_WIDTH = 320;
  const ID = 'pvr-sidebar-host';
  const MODES = ['push', 'float', 'overlay'];
  const NEXT_MODE = { push: 'float', float: 'overlay', overlay: 'push' };

  const S = (window.__pdfVoiceReaderSidebar = {
    host: null,
    root: null,
    frame: null,
    width: DEFAULT_WIDTH,
    mode: 'push',
    float: null, // {x, y, w, h} for float mode; null until first used
    tabId: null,
    dragging: false,
    dragRight: null, // right offset frozen for the duration of a drag
    prevHtmlWidth: null, // the page's own inline html width, restored on hide
  });

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const clampWidth = (w) => Math.round(clamp(w, MIN_WIDTH, window.innerWidth * MAX_FRACTION));

  // Width of the page's vertical scrollbar. The sidebar is offset by this so
  // the scrollbar stays visible at the far right instead of hidden beneath it.
  function scrollbarWidth() {
    const docEl = document.documentElement;
    const pushed = S.mode === 'push' && S.host ? S.width : 0;
    return Math.min(30, Math.max(0, window.innerWidth - docEl.clientWidth - pushed));
  }

  // Float geometry kept inside the viewport (header always reachable).
  function normalizeFloat(f) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.round(clamp(f?.w ?? S.width, MIN_WIDTH, vw * MAX_FRACTION));
    const h = Math.round(clamp(f?.h ?? Math.min(440, vh - 48), MIN_HEIGHT, vh));
    const x = Math.round(clamp(f?.x ?? vw - w - 24, 0, vw - w));
    const y = Math.round(clamp(f?.y ?? 24, 0, vh - 38));
    return { x, y, w, h };
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #ffffff;
      color: #1a1a1a;
      border-left: 1px solid rgba(0, 0, 0, 0.14);
      font: 13px system-ui, "Segoe UI", sans-serif;
    }
    .panel.overlay { box-shadow: -6px 0 24px rgba(0, 0, 0, 0.18); }
    .panel.float {
      border: 1px solid rgba(0, 0, 0, 0.18);
      border-radius: 10px;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.28);
    }
    .handle {
      position: absolute;
      left: -3px;
      top: 0;
      bottom: 0;
      width: 8px;
      cursor: ew-resize;
      z-index: 2;
    }
    .handle::after {
      content: "";
      position: absolute;
      left: 3px;
      top: 50%;
      width: 2px;
      height: 36px;
      margin-top: -18px;
      border-radius: 2px;
      background: rgba(0, 0, 0, 0.18);
      transition: background 120ms;
    }
    .panel.float .handle { left: 0; }
    .panel.float .handle::after { left: 2px; }
    .handle:hover::after, .panel.dragging .handle::after { background: #d43c32; }
    .handle-bottom, .handle-corner { display: none; position: absolute; z-index: 2; }
    .panel.float .handle-bottom {
      display: block;
      left: 12px;
      right: 0;
      bottom: 0;
      height: 7px;
      cursor: ns-resize;
    }
    .panel.float .handle-corner {
      display: block;
      left: 0;
      bottom: 0;
      width: 14px;
      height: 14px;
      cursor: nesw-resize;
    }
    .panel.dragging iframe { pointer-events: none; }
    header {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 38px;
      padding: 0 6px 0 10px;
      flex-shrink: 0;
      background: linear-gradient(45deg, #d43c32, #a01e5a);
      color: #fff;
      user-select: none;
    }
    .panel.float header { cursor: move; }
    header img { width: 18px; height: 18px; flex-shrink: 0; }
    .compact header .title { display: none; }
    .compact header { padding-left: 8px; }
    .micro header { padding: 0 4px; justify-content: center; }
    .micro header img, .micro header .mode { display: none; }
    header .title {
      flex: 1;
      min-width: 0;
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    header button {
      all: unset;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border-radius: 6px;
      color: #fff;
      cursor: pointer;
      flex-shrink: 0;
    }
    header button:hover { background: rgba(255, 255, 255, 0.18); }
    header button svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; }
    iframe {
      flex: 1;
      width: 100%;
      max-width: none;
      align-self: flex-start;
      border: 0;
      display: block;
      background: transparent;
      color-scheme: light dark;
    }
    .shield {
      position: fixed;
      inset: 0;
      z-index: 3;
    }
    @media (prefers-color-scheme: dark) {
      .panel { background: #1f1f1f; color: #eee; border-left-color: rgba(255, 255, 255, 0.16); }
      .panel.overlay { box-shadow: -6px 0 24px rgba(0, 0, 0, 0.5); }
      .panel.float { border-color: rgba(255, 255, 255, 0.18); box-shadow: 0 10px 32px rgba(0, 0, 0, 0.6); }
      .handle::after { background: rgba(255, 255, 255, 0.28); }
    }
  `;

  const ICON_PUSH =
    '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><line x1="9.5" y1="2.5" x2="9.5" y2="13.5"/><polyline points="6.5,6 4.5,8 6.5,10"/></svg>';
  const ICON_FLOAT =
    '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><rect x="6" y="6" width="7" height="5.5" rx="1" fill="currentColor" stroke="none" opacity="0.85"/></svg>';
  const ICON_OVERLAY =
    '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><rect x="8" y="4.5" width="5" height="7" rx="1" fill="currentColor" stroke="none" opacity="0.85"/></svg>';
  const ICON_CLOSE =
    '<svg viewBox="0 0 16 16"><line x1="3.5" y1="3.5" x2="12.5" y2="12.5"/><line x1="12.5" y1="3.5" x2="3.5" y2="12.5"/></svg>';

  const MODE_UI = {
    push: { icon: ICON_PUSH, title: 'Sidebar, page pushed aside — click to detach as a floating window' },
    float: { icon: ICON_FLOAT, title: 'Floating window — click to dock as a sidebar over the page' },
    overlay: { icon: ICON_OVERLAY, title: 'Sidebar over the page — click to push the page aside' },
  };

  function build() {
    const host = document.createElement('div');
    host.id = ID;
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;

    const panel = document.createElement('div');
    panel.className = 'panel';

    const handle = document.createElement('div');
    handle.className = 'handle';
    handle.title = 'Drag to resize';
    const handleBottom = document.createElement('div');
    handleBottom.className = 'handle-bottom';
    const handleCorner = document.createElement('div');
    handleCorner.className = 'handle-corner';

    const header = document.createElement('header');
    const icon = document.createElement('img');
    icon.src = chrome.runtime.getURL('icons/icon48.png');
    icon.alt = '';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = 'PDF Voice Reader';
    const modeBtn = document.createElement('button');
    modeBtn.className = 'mode';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close';
    closeBtn.title = 'Close sidebar (or click the extension icon)';
    closeBtn.innerHTML = ICON_CLOSE;
    header.append(icon, title, modeBtn, closeBtn);

    const frame = document.createElement('iframe');
    frame.allow = 'autoplay';

    panel.append(handle, handleBottom, handleCorner, header, frame);
    root.append(style, panel);

    S.host = host;
    S.root = root;
    S.frame = frame;
    S.panel = panel;
    S.modeBtn = modeBtn;

    handle.addEventListener('pointerdown', (e) => startResize(e, 'left'));
    handleBottom.addEventListener('pointerdown', (e) => startResize(e, 'bottom'));
    handleCorner.addEventListener('pointerdown', (e) => startResize(e, 'corner'));
    header.addEventListener('pointerdown', startMove);
    // Clicks on the sidebar are ours: keep them from reaching the page's own
    // listeners (menus that close on outside-click, etc.).
    for (const evt of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      host.addEventListener(evt, (e) => e.stopPropagation());
    }
    closeBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ target: 'sw', type: 'sidebar-close' }).catch(() => {});
    });
    modeBtn.addEventListener('click', () => {
      const mode = NEXT_MODE[S.mode] ?? 'push';
      applyMode(mode);
      chrome.storage.local.set({ sidebarMode: mode });
    });

    return host;
  }

  // Inline !important styles so page CSS targeting divs can't reposition us.
  // Static part runs once; geometry is updated separately so a resize touches
  // only a few properties instead of resetting every one.
  function styleHostStatic() {
    const st = S.host.style;
    const set = (k, v) => st.setProperty(k, v, 'important');
    set('all', 'initial');
    set('position', 'fixed');
    set('z-index', '2147483647');
    set('display', 'block');
    set('margin', '0');
    set('padding', '0');
  }

  function styleHostGeometry() {
    const st = S.host.style;
    const set = (k, v) => st.setProperty(k, v, 'important');
    if (S.mode === 'float') {
      const f = S.float;
      set('left', `${f.x}px`);
      set('top', `${f.y}px`);
      set('right', 'auto');
      set('width', `${f.w}px`);
      set('height', `${f.h}px`);
      return;
    }
    // While dragging, the right offset is frozen: pushing the page can add or
    // remove its scrollbar mid-drag, which would otherwise nudge the sidebar.
    const right = S.dragging ? S.dragRight : scrollbarWidth();
    set('left', 'auto');
    set('top', '0');
    set('right', `${right}px`);
    set('width', `${S.width}px`);
    set('height', '100vh');
  }

  function applyPush() {
    const docEl = document.documentElement;
    if (S.mode === 'push') {
      if (S.prevHtmlWidth === null) S.prevHtmlWidth = docEl.style.width || '';
      docEl.style.setProperty('width', `calc(100% - ${S.width}px)`, 'important');
    } else if (S.prevHtmlWidth !== null) {
      docEl.style.width = S.prevHtmlWidth;
      S.prevHtmlWidth = null;
    }
  }

  // Header trims itself as the panel narrows: title goes first, then the
  // icon and mode button, leaving just ✕ at the minimum width.
  function applyDensity() {
    const w = S.mode === 'float' ? S.float.w : S.width;
    S.panel.classList.toggle('compact', w < 200);
    S.panel.classList.toggle('micro', w < 120);
  }

  function applyMode(mode) {
    S.mode = MODES.includes(mode) ? mode : 'push';
    if (!S.host) return;
    if (S.mode === 'float') S.float = normalizeFloat(S.float);
    for (const m of MODES) S.panel.classList.toggle(m, S.mode === m);
    S.modeBtn.innerHTML = MODE_UI[S.mode].icon;
    S.modeBtn.title = MODE_UI[S.mode].title;
    applyPush();
    applyDensity();
    styleHostGeometry();
  }

  function applyWidth(width) {
    S.width = clampWidth(width);
    if (!S.host) return;
    applyPush();
    applyDensity();
    styleHostGeometry();
  }

  function applyFloat(f) {
    S.float = normalizeFloat(f);
    if (!S.host || S.mode !== 'float') return;
    applyDensity();
    styleHostGeometry();
  }

  // ---------- drag (move / resize) ----------
  //
  // Smoothness rules: the iframe is a cross-process frame, so resizing it on
  // every mouse move repaints asynchronously and flickers — its size is
  // frozen for a resize and clipped by the panel, then set once on release
  // (which is also the only moment its responsive breakpoints re-evaluate).
  // Updates are coalesced to one per animation frame, and the pointer is
  // captured by the handle so the page and iframe never see the drag.

  function beginDrag(e, { cursor, freezeFrame, onMove, onEnd }) {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // capture unsupported — window listener below still ends the drag
    }
    S.dragging = true;
    S.dragRight = scrollbarWidth();
    S.panel.classList.add('dragging');
    const shield = document.createElement('div');
    shield.className = 'shield';
    shield.style.cursor = cursor;
    S.root.append(shield);
    if (freezeFrame) {
      const r = S.frame.getBoundingClientRect();
      S.frame.style.width = `${Math.round(r.width)}px`;
      S.frame.style.height = `${Math.round(r.height)}px`;
      S.frame.style.flex = 'none';
    }

    let raf = 0;
    let last = e;
    const move = (ev) => {
      last = ev;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          onMove(last);
        });
      }
    };
    const end = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      window.removeEventListener('pointerup', end, true);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        // already released
      }
      shield.remove();
      S.panel.classList.remove('dragging');
      S.dragging = false;
      S.dragRight = null;
      if (freezeFrame) {
        S.frame.style.width = '';
        S.frame.style.height = '';
        S.frame.style.flex = '';
      }
      onMove(last);
      onEnd();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    window.addEventListener('pointerup', end, true); // safety net if capture was refused
  }

  function startResize(e, edge) {
    const cursor = edge === 'left' ? 'ew-resize' : edge === 'bottom' ? 'ns-resize' : 'nesw-resize';
    if (S.mode !== 'float') {
      const rightEdge = window.innerWidth - scrollbarWidth();
      beginDrag(e, {
        cursor,
        freezeFrame: true,
        onMove: (ev) => applyWidth(rightEdge - ev.clientX),
        onEnd: () => chrome.storage.local.set({ sidebarWidth: S.width }),
      });
      return;
    }
    const start = { ...S.float };
    const right = start.x + start.w; // right edge stays put when pulling the left edge
    beginDrag(e, {
      cursor,
      freezeFrame: true,
      onMove: (ev) => {
        const next = { ...S.float };
        if (edge !== 'bottom') {
          const x = clamp(ev.clientX, 0, right - MIN_WIDTH);
          next.x = x;
          next.w = right - x;
        }
        if (edge !== 'left') next.h = ev.clientY - start.y;
        applyFloat(next);
      },
      onEnd: () => chrome.storage.local.set({ sidebarFloat: S.float }),
    });
  }

  function startMove(e) {
    if (S.mode !== 'float') return;
    if (e.target.closest('button')) return;
    const start = { ...S.float };
    const x0 = e.clientX;
    const y0 = e.clientY;
    beginDrag(e, {
      cursor: 'move',
      freezeFrame: false,
      onMove: (ev) => applyFloat({ ...start, x: start.x + (ev.clientX - x0), y: start.y + (ev.clientY - y0) }),
      onEnd: () => chrome.storage.local.set({ sidebarFloat: S.float }),
    });
  }

  // ---------- show / hide ----------

  function show({ tabId, width, mode, float }) {
    S.tabId = tabId;
    if (typeof width === 'number') S.width = clampWidth(width);
    if (float && typeof float === 'object') S.float = normalizeFloat(float);
    if (!S.host) {
      build();
      styleHostStatic();
      (document.body || document.documentElement).appendChild(S.host);
      const src = new URL(chrome.runtime.getURL('popup/popup.html'));
      src.searchParams.set('embed', '1');
      if (tabId != null) src.searchParams.set('tabId', String(tabId));
      S.frame.src = src.href;
    } else if (!S.host.isConnected) {
      (document.body || document.documentElement).appendChild(S.host);
    }
    applyMode(mode);
  }

  function hide() {
    if (!S.host) return;
    S.host.remove();
    const docEl = document.documentElement;
    if (S.prevHtmlWidth !== null) {
      docEl.style.width = S.prevHtmlWidth;
      S.prevHtmlWidth = null;
    }
    S.host = null;
    S.frame = null;
    S.root = null;
  }

  // ---------- wiring ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.target !== 'sidebar') return;
    if (msg.type === 'show') show(msg);
    else if (msg.type === 'hide') hide();
    sendResponse({ visible: !!S.host, width: S.width, mode: S.mode, float: S.float });
  });

  // Keep width/mode/float geometry in step with other tabs where the user
  // resized, moved or toggled.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !S.host || S.dragging) return;
    if (changes.sidebarFloat && changes.sidebarFloat.newValue) S.float = normalizeFloat(changes.sidebarFloat.newValue);
    if (changes.sidebarMode) applyMode(changes.sidebarMode.newValue);
    if (changes.sidebarWidth && typeof changes.sidebarWidth.newValue === 'number') {
      applyWidth(changes.sidebarWidth.newValue);
    }
    if (changes.sidebarFloat && S.mode === 'float') applyFloat(S.float);
  });

  window.addEventListener('resize', () => {
    if (!S.host || S.dragging) return;
    if (S.mode === 'float') applyFloat(S.float);
    else applyWidth(S.width);
  });
})();
