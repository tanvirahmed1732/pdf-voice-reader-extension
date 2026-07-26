// Thin DOM layer for the player toolbar; reader.js supplies the callbacks.

import { PlayerState } from './player.js';

export class Toolbar {
  constructor() {
    this.playBtn = document.getElementById('btn-play');
    this.stopBtn = document.getElementById('btn-stop');
    this.prevBtn = document.getElementById('btn-prev');
    this.nextBtn = document.getElementById('btn-next');
    this.rateSel = document.getElementById('sel-rate');
    this.rateDownBtn = document.getElementById('btn-rate-down');
    this.rateUpBtn = document.getElementById('btn-rate-up');
    this.rate = 1;
    this.voiceSel = document.getElementById('sel-voice');
    this.voicesBtn = document.getElementById('btn-voices');
    this.zoomInBtn = document.getElementById('btn-zoom-in');
    this.zoomOutBtn = document.getElementById('btn-zoom-out');
    this.statusEl = document.getElementById('status');

    this.onPlay = null;
    this.onStop = null;
    this.onSkip = null; // (delta)
    this.onRateChange = null; // (rate)
    this.onVoiceChange = null; // ({kind, id})
    this.onManageVoices = null;
    this.onZoom = null; // (factor)

    this.playBtn.addEventListener('click', () => this.onPlay?.());
    this.stopBtn.addEventListener('click', () => this.onStop?.());
    this.prevBtn.addEventListener('click', () => this.onSkip?.(-1));
    this.nextBtn.addEventListener('click', () => this.onSkip?.(1));
    this.rateSel.addEventListener('change', () => this.setRate(Number(this.rateSel.value), true));
    this.rateDownBtn.addEventListener('click', () => this.setRate(this.rate - 0.05, true));
    this.rateUpBtn.addEventListener('click', () => this.setRate(this.rate + 0.05, true));
    this.voiceSel.addEventListener('change', () => {
      const [kind, ...rest] = this.voiceSel.value.split(':');
      this.onVoiceChange?.({ kind, id: rest.join(':') });
    });
    this.voicesBtn.addEventListener('click', () => this.onManageVoices?.());
    this.zoomInBtn.addEventListener('click', () => this.onZoom?.(1.2));
    this.zoomOutBtn.addEventListener('click', () => this.onZoom?.(1 / 1.2));
  }

  // Clamped to 0.25–3, 0.05 steps. Non-preset values show as a custom option
  // in the dropdown. emit=true fires onRateChange (user action); false = just
  // reflect the stored setting on load.
  setRate(rate, emit = false) {
    rate = Math.min(3, Math.max(0.25, Math.round(rate * 100) / 100));
    this.rate = rate;
    const val = String(rate);
    const preset = [...this.rateSel.options].find(
      (o) => !o.classList.contains('custom-rate') && o.value === val,
    );
    let custom = this.rateSel.querySelector('option.custom-rate');
    if (preset) {
      if (custom) custom.remove();
    } else {
      if (!custom) {
        custom = document.createElement('option');
        custom.className = 'custom-rate';
        this.rateSel.appendChild(custom);
      }
      custom.value = val;
      custom.textContent = `${rate}×`;
    }
    this.rateSel.value = val;
    if (emit) this.onRateChange?.(rate);
  }

  setPlayState(state) {
    const active = state !== PlayerState.IDLE;
    this.stopBtn.disabled = !active;
    this.prevBtn.disabled = !active;
    this.nextBtn.disabled = !active;
    if (state === PlayerState.PLAYING) {
      this.playBtn.textContent = '⏸ Pause';
      this.playBtn.title = 'Pause (Space)';
    } else if (state === PlayerState.PAUSED) {
      this.playBtn.textContent = '▶ Resume';
      this.playBtn.title = 'Resume (Space)';
    } else {
      this.playBtn.textContent = '▶ Read';
      this.playBtn.title = 'Read from selection (Space)';
    }
  }

  setStatus(text) {
    this.statusEl.textContent = text;
  }

  // groups: [{label, voices: [{value, label}]}]
  populateVoices(groups, selectedValue) {
    this.voiceSel.textContent = '';
    for (const group of groups) {
      if (!group.voices.length) continue;
      const og = document.createElement('optgroup');
      og.label = group.label;
      for (const v of group.voices) {
        const opt = document.createElement('option');
        opt.value = v.value;
        opt.textContent = v.label;
        og.appendChild(opt);
      }
      this.voiceSel.appendChild(og);
    }
    if (selectedValue && [...this.voiceSel.options].some((o) => o.value === selectedValue)) {
      this.voiceSel.value = selectedValue;
    }
  }

  get selectedVoiceValue() {
    return this.voiceSel.value;
  }
}
