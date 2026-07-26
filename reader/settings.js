// Persisted user settings (voice + speed) via chrome.storage.local.
// local (not sync): voice availability is machine-specific.

const KEY = 'settings.v1';

const DEFAULTS = {
  engineKind: 'edge', // 'edge' | 'system' | 'neural'
  edgeVoiceId: 'en-US-AndrewMultilingualNeural',
  systemVoiceId: null, // voiceURI
  neuralVoiceId: null, // piper voice id, e.g. 'en_US-lessac-medium'
  rate: 1,
};

export async function loadSettings() {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  return { ...DEFAULTS, ...(stored ?? {}) };
}

let pending = null;
export function saveSettings(settings) {
  clearTimeout(pending);
  pending = setTimeout(() => {
    chrome.storage.local.set({ [KEY]: settings });
  }, 250);
}
