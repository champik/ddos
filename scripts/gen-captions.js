'use strict';
// gen-captions.js — karaoke-style ASS captions from transcripts for Shorts
// Current word highlighted yellow, rest white. Max 3 words per chunk.
// Usage: node scripts/gen-captions.js <projectDir>

const fs = require('fs');
const path = require('path');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node gen-captions.js <projectDir>'); process.exit(1); }

require('./progress').step(projectDir, 11, 'Субтитри для шортсів');

const { readJson, updateState } = require('./lib/state');
const { analyzeRms, loudThreshold, isLoudAt, isProminentAt } = require('./lib/audio-peaks');
const { normalizeWord, isProfane, maskWord } = require('./lib/profanity');
const plan = readJson(path.join(projectDir, 'edit/episode-plan.json'));

let editorialClips = {};
let editorialShortsArray = null;
try {
  const ed = readJson(path.join(projectDir, 'edit/editorial.json'));
  editorialClips = ed.clips || {};
  if (ed.shorts && ed.shorts.length > 0) editorialShortsArray = ed.shorts;
} catch {}

// Words that should not end a phrase chunk (soft break only — forced breaks still apply)
const FUNCTION_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','am',
  'i','we','you','he','she','they','them','him','her','us',
  'it','its','my','your','his','our','their',
  'in','on','at','to','of','by','for','with','from','into',
  'and','but','or','so','nor','as','if','than',
  'not','do','did','does','have','has','had',
  'will','would','could','should','can','may','might',
  'that','this','just','up','out','then','also',
]);

function isFn(word)  { return FUNCTION_WORDS.has(word.replace(/[^a-z]/g, '').toLowerCase()); }

function toAssTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

// Group words into karaoke chunks.
// Forced splits: pause > 0.35s, sentence-ending punctuation, Whisper segment boundary.
// Soft splits: comma/semicolon, span > 1.2s, or ≥3 words — but NOT after a function word.
// Hard cap: 4 words regardless of function word.
function groupIntoPhrases(words) {
  const phrases = [];
  let current = [];

  for (let i = 0; i < words.length; i++) {
    const w    = words[i];
    const prev = current[current.length - 1];
    const gap  = prev ? w.start - prev.end : 0;
    const prevText = prev ? prev.word.trim() : '';

    const segBreak    = prev && w.seg != null && prev.seg != null && w.seg !== prev.seg;
    const longPause   = gap > 0.35;
    const sentenceEnd = /[.!?]$/.test(prevText);
    const commaBreak  = /[,;]$/.test(prevText);
    const spanTooLong = current.length > 0 && (w.start - current[0].start) > 1.2;
    const atSoftLimit = current.length >= 4 && !isFn(prevText);
    const atHardCap   = current.length >= 5;

    const forced = longPause || (sentenceEnd && gap > 0.10) || segBreak;
    const soft   = commaBreak || atSoftLimit || atHardCap || spanTooLong;

    if (current.length > 0 && (forced || soft)) {
      phrases.push(current);
      current = [w];
    } else {
      current.push(w);
    }
  }
  if (current.length > 0) phrases.push(current);
  return phrases;
}

// ASS BGR colors
const YELLOW = '&H003DFFF5'; // #f5ff3d
const WHITE  = '&H00E6F0F4'; // light cream-white

const VERTICAL_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 1

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Impact,72,${YELLOW},${YELLOW},&H00000000,&HCC000000,-1,0,0,0,100,100,0,0,1,5,0,2,10,10,340,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

// Build one ASS dialogue text for a phrase where phraseWords[currentIdx] is highlighted.
// Style PrimaryColour is YELLOW so the first word needs no tag if it's current.
// phraseLoud[j] = true → UPPERCASE (shouting), false → lowercase
function buildKaraokeText(phraseWords, currentIdx, pop, phraseLoud) {
  const parts = [];
  if (pop) parts.push(pop);

  for (let j = 0; j < phraseWords.length; j++) {
    const loud = phraseLoud && phraseLoud[j];
    const raw = phraseWords[j].word.trim();
    const text = isProfane(normalizeWord(raw))
      ? maskWord(raw)
      : (loud ? raw.toUpperCase() : raw.toLowerCase());

    if (j === currentIdx) {
      if (j > 0) parts.push(`{\\c${YELLOW}&}`); // reset to yellow after white stretch
      parts.push(text);
    } else if (j === currentIdx + 1 || (j === 0 && currentIdx > 0)) {
      parts.push(`{\\c${WHITE}&}`);
      parts.push(text);
    } else {
      parts.push(text); // same color as previous word
    }

    if (j < phraseWords.length - 1) parts.push(' ');
  }
  return parts.join('');
}

// Generate karaoke ASS: one dialogue line per word, whole phrase visible,
// current word yellow, others white. Hot/loud words get a brief scale-pop.
function genKaraokeAss(words, header, offset = 0, isLoudWord = null) {
  if (!words || words.length === 0) return header;
  const phrases = groupIntoPhrases(words);

  const events = [];
  for (const phraseWords of phrases) {
    // UPPERCASE = loud by RMS only (not keywords)
    // Розповзання капсу на всю фразу — тільки якщо гучних слів ≥2 або ≥половини
    // фрази: один хибний спрацьований КАПС не має капсити 4-5 сусідніх слів.
    const _wordLoud = phraseWords.map(pw => isLoudWord ? isLoudWord(pw) : false);
    const loudCount = _wordLoud.filter(Boolean).length;
    const spread = loudCount >= 2 || (loudCount > 0 && loudCount >= Math.ceil(phraseWords.length / 2));
    const phraseLoud = spread ? _wordLoud.map(() => true) : _wordLoud;

    for (let i = 0; i < phraseWords.length; i++) {
      const w      = phraseWords[i];
      const startT = w.start + offset;
      const endT   = i < phraseWords.length - 1
        ? phraseWords[i + 1].start + offset
        : w.end + offset + 0.15;

      if (endT <= startT + 0.04) continue;

      const pop  = phraseLoud[i] ? '{\\fscx100\\fscy100\\t(0,90,\\fscx107\\fscy107)}' : '';
      const text = buildKaraokeText(phraseWords, i, pop, phraseLoud);

      events.push({ startT, endT, text });
    }
  }

  events.sort((a, b) => a.startT - b.startT);
  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].endT > events[i + 1].startT) events[i].endT = events[i + 1].startT;
  }

  const lines = [header];
  for (const ev of events) {
    if (ev.endT > ev.startT + 0.01) {
      lines.push(`Dialogue: 0,${toAssTime(ev.startT)},${toAssTime(ev.endT)},Default,,0,0,0,,${ev.text}`);
    }
  }
  return lines.join('\n');
}

// --- Per-clip ---
console.log(`\n=== gen-captions.js ===\n`);

const clipIds = plan.shortClipIds || [];

// New format (editorial.shorts array): merge/ranking items list all member
// clip ids directly. Old format: combineWith on the primary clip's editorial
// entry. render-shorts.js branches on the same editorialShortsArray presence
// check — keep both in sync.
const combineWithIds = [];
if (editorialShortsArray) {
  for (const item of editorialShortsArray) {
    const ids = item.type === 'solo' ? [item.clipId] : (item.clips || []);
    combineWithIds.push(...ids);
  }
} else {
  for (const clipId of clipIds) {
    const secondary = editorialClips[clipId]?.short?.combineWith || [];
    combineWithIds.push(...secondary);
  }
}
const allCaptionIds = [...new Set([...clipIds, ...combineWithIds])];

let generated = 0;

for (const clipId of allCaptionIds) {
  const transcriptPath = path.join(projectDir, 'processed', clipId, 'transcript.json');
  if (!fs.existsSync(transcriptPath)) { console.log(`[SKIP] No transcript: ${clipId}`); continue; }

  const tr = readJson(transcriptPath);
  if (!tr.words || tr.words.length === 0) { console.log(`[SKIP] No words: ${clipId}`); continue; }

  if (editorialClips[clipId]?.short?.captionsOff === true) {
    const assPath = path.join(projectDir, 'processed', clipId, 'captions-vertical.ass');
    if (fs.existsSync(assPath)) fs.unlinkSync(assPath);
    console.log(`[SKIP] captions OFF: ${clipId}`);
    continue;
  }

  if (editorialClips[clipId]?.short?.captionsFixed === true) {
    console.log(`[SKIP] captions FIXED (manual): ${clipId}`);
    continue;
  }

  // Детект крику: пріоритетно по vocals_rms з transcript.json — це гучність
  // ЧИСТОГО ВОКАЛУ (після demucs), тому гучний геймплей/музика не капсять текст.
  // Fallback (старі транскрипти) — RMS повного міксу з clean.mp4.
  let isLoudWord = null;
  let windows = null;
  if (Array.isArray(tr.vocals_rms) && tr.vocals_rms.length >= 4) {
    windows = tr.vocals_rms.map(([t, rms]) => ({ t, rms }));
  } else {
    const audioSrc = path.join(projectDir, 'processed', clipId, 'clean.mp4');
    if (fs.existsSync(audioSrc)) windows = analyzeRms(audioSrc);
  }
  if (windows) {
    const threshold = loudThreshold(windows, 8);
    if (threshold != null) {
      // Крик = гучно відносно всього кліпу І сплеск відносно сусідніх ±1с
      isLoudWord = (w) => {
        const mid = (w.start + w.end) / 2;
        return isLoudAt(windows, threshold, mid) && isProminentAt(windows, mid);
      };
    }
  }

  const transcriptOffset = editorialClips[clipId]?.short?.transcriptOffset ?? 0;
  const vAss = genKaraokeAss(tr.words, VERTICAL_HEADER, transcriptOffset, isLoudWord);
  fs.writeFileSync(path.join(projectDir, 'processed', clipId, 'captions-vertical.ass'), vAss, 'utf8');

  const phrases = groupIntoPhrases(tr.words);
  generated++;
  console.log(`[OK] ${clipId} — ${tr.words.length} words, ${phrases.length} phrases`);
}

console.log(`\n[DONE] Generated ${generated} shorts captions\n`);

updateState(projectDir, s => {
  s.stages = s.stages || {};
  s.stages.captions = 'done';
});
