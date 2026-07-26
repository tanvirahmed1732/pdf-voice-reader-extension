// Shared TTS engine contract + word-timing estimation helpers.
//
// interface TtsEngine {
//   init(): Promise<void>
//   listVoices(): Promise<VoiceInfo[]>   // {id, name, lang, kind: 'system'|'neural'}
//   setVoice(id): Promise<void> | void
//   setRate(r): void                     // 0.5–2.0; may take effect mid-sentence
//   speak(sentences, startIndex): void   // sentences: [{text, start, end}]
//   pause(): void
//   resume(): void
//   stop(): void
//   // callbacks assigned by the player:
//   onSentenceStart(k), onSentenceEnd(k)
//   onWordBoundary(k, charStart, charLength, exact)
//   onDone(), onError(message)
// }

// Splits text into word tokens with their character positions.
export function wordTokens(text) {
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ charStart: m.index, charLength: m[0].length });
  }
  return tokens;
}

// Distributes a known audio duration across words, proportional to length.
// Returns [{charStart, charLength, tStart}] with tStart in seconds.
export function estimateWordTimings(text, durationSec) {
  const tokens = wordTokens(text);
  const totalWeight = tokens.reduce((n, t) => n + t.charLength + 1, 0) || 1;
  let acc = 0;
  return tokens.map((t) => {
    const tStart = (acc / totalWeight) * durationSec;
    acc += t.charLength + 1;
    return { ...t, tStart };
  });
}

// Fallback pace when no duration is known (Web Speech voices without
// boundary events): roughly 170 wpm at rate 1.
export function estimatedWordsPerSecond(rate) {
  return (170 / 60) * rate;
}
