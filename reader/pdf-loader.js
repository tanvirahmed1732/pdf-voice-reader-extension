// Obtains raw PDF bytes from the ?file= URL param, a picked file, or drag-drop.

export function fileParam() {
  const raw = new URLSearchParams(location.search).get('file');
  return raw ? raw : null;
}

export function filenameFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name || 'document.pdf';
  } catch {
    return 'document.pdf';
  }
}

async function fetchHttp(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the PDF (HTTP ${response.status}).`);

  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received, total);
  }
  const data = new Uint8Array(received);
  let pos = 0;
  for (const chunk of chunks) {
    data.set(chunk, pos);
    pos += chunk.length;
  }
  return data;
}

// fetch() refuses file: URLs; XHR from an extension page works once
// "Allow access to file URLs" is granted.
function fetchFileUrl(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      if (xhr.response && xhr.response.byteLength > 0) {
        resolve(new Uint8Array(xhr.response));
      } else {
        reject(new FileAccessError());
      }
    };
    xhr.onerror = () => reject(new FileAccessError());
    xhr.send();
  });
}

export class FileAccessError extends Error {
  constructor() {
    super('Could not read the local file. Enable "Allow access to file URLs" for this extension.');
    this.name = 'FileAccessError';
  }
}

export async function loadFromUrl(url, onProgress) {
  const scheme = new URL(url).protocol;
  if (scheme === 'file:') {
    const allowed = await chrome.extension.isAllowedFileSchemeAccess();
    if (!allowed) throw new FileAccessError();
    return fetchFileUrl(url);
  }
  return fetchHttp(url, onProgress);
}

// Wires the empty-state picker + full-page drag-drop; calls onFile(file) once a PDF arrives.
export function initFilePicker(onFile) {
  const input = document.getElementById('file-input');
  const pickBtn = document.getElementById('btn-pick');

  pickBtn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files[0]) onFile(input.files[0]);
  });

  let dragDepth = 0;
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragover');
  });
  document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('dragover');
    }
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragover');
    const file = [...(e.dataTransfer?.files ?? [])].find(
      (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
    );
    if (file) onFile(file);
  });
}
