// Neural voice catalog: download / delete Piper voice models (cached in OPFS)
// and report which ones are installed.

// Medium-quality models only: "high" models synthesize at ~0.3× realtime on
// single-threaded WASM (the only mode MV3 CSP allows), which stutters —
// medium models run ~3× realtime and read smoothly.
const CATALOG = [
  { id: 'en_US-lessac-medium', name: 'Lessac — US English, neutral', size: '≈64 MB' },
  { id: 'en_US-amy-medium', name: 'Amy — US English, female', size: '≈64 MB' },
  { id: 'en_US-ryan-medium', name: 'Ryan — US English, male', size: '≈64 MB' },
  { id: 'en_US-hfc_male-medium', name: 'HFC — US English, male', size: '≈64 MB' },
  { id: 'en_US-hfc_female-medium', name: 'HFC — US English, female', size: '≈64 MB' },
  { id: 'en_GB-alba-medium', name: 'Alba — British English, female', size: '≈64 MB' },
];

// Previously offered voices that are too slow for live reading → replacement.
const LEGACY_MAP = {
  'en_US-ryan-high': 'en_US-ryan-medium',
  'en_US-libritts-high': 'en_US-lessac-medium',
};

export function migrateVoiceId(id) {
  return LEGACY_MAP[id] ?? id;
}

let piperModule = null;
async function piper() {
  if (!piperModule) {
    piperModule = await import(chrome.runtime.getURL('vendor/piper/piper-bundle.js'));
  }
  return piperModule;
}

export async function installedNeuralVoices() {
  const { stored } = await piper();
  const installed = new Set(await stored());
  return CATALOG.filter((v) => installed.has(v.id));
}

export async function openVoicePanel({ onInstalledChanged, onSelectVoice }) {
  const panel = document.getElementById('voice-panel');
  const list = document.getElementById('voice-list');
  const storageInfo = document.getElementById('storage-info');
  const closeBtn = document.getElementById('btn-close-panel');

  panel.hidden = false;
  closeBtn.onclick = () => {
    panel.hidden = true;
  };

  const { stored, download, remove } = await piper();

  async function updateStorageInfo() {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      const mb = (n) => (n / 1024 / 1024).toFixed(0);
      const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(1);
      storageInfo.textContent = `Voices and cache use ${mb(usage)} MB of ${gb(quota)} GB available.`;
    } catch {
      storageInfo.textContent = '';
    }
  }

  async function render() {
    const installed = new Set(await stored());
    list.textContent = '';

    for (const voice of CATALOG) {
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'voice-row';

      const info = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'voice-name';
      name.textContent = voice.name;
      const meta = document.createElement('div');
      meta.className = 'voice-meta';
      meta.textContent = installed.has(voice.id) ? `${voice.id} · installed` : `${voice.id} · ${voice.size}`;
      info.append(name, meta);
      row.appendChild(info);

      const actions = document.createElement('div');
      if (installed.has(voice.id)) {
        const useBtn = document.createElement('button');
        useBtn.textContent = 'Use';
        useBtn.className = 'download';
        useBtn.onclick = () => {
          panel.hidden = true;
          onSelectVoice?.(voice.id);
        };
        const delBtn = document.createElement('button');
        delBtn.textContent = 'Delete';
        delBtn.style.marginLeft = '6px';
        delBtn.onclick = async () => {
          delBtn.disabled = true;
          await remove(voice.id);
          await render();
          onInstalledChanged?.();
        };
        actions.append(useBtn, delBtn);
      } else {
        const dlBtn = document.createElement('button');
        dlBtn.textContent = 'Download';
        dlBtn.className = 'download';
        dlBtn.onclick = async () => {
          dlBtn.disabled = true;
          dlBtn.textContent = 'Downloading…';
          const progress = document.createElement('progress');
          progress.max = 100;
          progress.value = 0;
          li.appendChild(progress);
          try {
            await download(voice.id, (p) => {
              if (p.total) progress.value = Math.round((p.loaded / p.total) * 100);
            });
            // Reduce the chance of the browser evicting the downloaded models.
            navigator.storage.persist?.();
            await render();
            onInstalledChanged?.();
          } catch (err) {
            progress.remove();
            dlBtn.disabled = false;
            dlBtn.textContent = 'Retry download';
            meta.textContent = `Download failed: ${err.message}`;
          }
        };
        actions.appendChild(dlBtn);
      }
      row.appendChild(actions);
      li.appendChild(row);
      list.appendChild(li);
    }

    // Installed voices we no longer offer (e.g. "high" models, which are too
    // slow for live reading) — give the user a way to free the disk space.
    const catalogIds = new Set(CATALOG.map((v) => v.id));
    for (const id of installed) {
      if (catalogIds.has(id)) continue;
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'voice-row';
      const info = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'voice-name';
      name.textContent = id;
      const meta = document.createElement('div');
      meta.className = 'voice-meta';
      meta.textContent = 'no longer offered — too slow for live reading';
      info.append(name, meta);
      const delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.onclick = async () => {
        delBtn.disabled = true;
        await remove(id);
        await render();
        onInstalledChanged?.();
      };
      row.append(info, delBtn);
      li.appendChild(row);
      list.appendChild(li);
    }
    updateStorageInfo();
  }

  await render();
}
