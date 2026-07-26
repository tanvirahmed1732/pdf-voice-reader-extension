// Module worker hosting the Piper session so ONNX inference and phonemization
// never block the reader UI. Synthesis requests run strictly one at a time —
// concurrent runs on single-threaded WASM just steal CPU from the sentence
// that is needed next — and pending work is dropped on cancelAll (skip/stop).

import { PiperSession } from '../vendor/piper/piper-bundle.js';

let session = null;
const queue = [];
let busy = false;

async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const msg = queue.shift();
    try {
      const { pcm, sampleRate } = await session.synthesize(msg.text, msg.rate);
      self.postMessage({ type: 'audio', reqId: msg.reqId, pcm, sampleRate }, [pcm.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', reqId: msg.reqId, message: String(err?.message ?? err) });
    }
  }
  busy = false;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      session = new PiperSession({ wasmRoot: msg.wasmRoot });
      await session.setVoice(msg.voiceId, (frac) => {
        self.postMessage({ type: 'progress', reqId: msg.reqId, frac });
      });
      self.postMessage({ type: 'ready', reqId: msg.reqId });
    } else if (msg.type === 'synth') {
      if (!session) throw new Error('Worker not initialized');
      queue.push(msg);
      drain();
    } else if (msg.type === 'cancelAll') {
      for (const pending of queue.splice(0)) {
        self.postMessage({ type: 'error', reqId: pending.reqId, message: 'canceled' });
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', reqId: msg.reqId, message: String(err?.message ?? err) });
  }
};
