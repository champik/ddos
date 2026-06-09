'use strict';
// gen-captions.js — phrase-based ASS captions from transcripts for Shorts
// Usage: node scripts/gen-captions.js <projectDir>

const fs = require('fs');
const path = require('path');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node gen-captions.js <projectDir>'); process.exit(1); }

require('./progress').step(projectDir, 9, 'Субтитри для шортсів');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
const plan = readJson(path.join(projectDir, 'edit/episode-plan.json'));

// Read editorial for per-clip overrides (captionsOff etc.)
let editorialClips = {};
try { editorialClips = readJson(path.join(projectDir, 'edit/editorial.json')).clips || {}; } catch {}

// Hot words trigger emotional highlight
const HOT = new Set(['no','bro','what','wait','oh','stop','go','yes','wtf','literally',
  'insane','crazy','nah','holy','hell','wow','bruh','yo','omg','damn','actually',
  'really','seriously','dude','man','guys','let','come','look','watch']);

function isHot(word) {
  return HOT.has(word.replace(/[^a-z]/g, '').toLowerCase());
}

function toAssTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

// Group words into natural phrases.
// Primary split: Whisper segment boundary (seg field) — never merge across segments.
// Secondary splits: pause > 0.35s, sentence-ending punctuation, comma/semicolon, max 4 words.
// Falls back gracefully for old transcripts without seg field.
function groupIntoPhrases(words) {
  const phrases = [];
  let current = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = current[current.length - 1];
    const gap = prev ? w.start - prev.end : 0;
    const prevText = prev ? prev.word.trim() : '';

    const segBreak   = prev && w.seg != null && prev.seg != null && w.seg !== prev.seg;
    const longPause  = gap > 0.35;
    const sentenceEnd = /[.!?]$/.test(prevText);
    const commaBreak = /[,;]$/.test(prevText);
    const tooLong    = current.length >= 4;

    if (current.length > 0 && (segBreak || longPause || sentenceEnd || commaBreak || tooLong)) {
      phrases.push(current);
      current = [w];
    } else {
      current.push(w);
    }
  }
  if (current.length > 0) phrases.push(current);
  return phrases;
}

// A phrase is emotional if it contains a hot word, ALL CAPS word, or exclamation
function isEmotional(phraseWords) {
  for (const w of phraseWords) {
    const t = w.word.trim();
    if (isHot(t)) return true;
    if (t.endsWith('!') || t.endsWith('?!')) return true;
    if (t.length >= 2 && t === t.toUpperCase() && /[A-Z]/.test(t)) return true;
  }
  return false;
}

// ASS color for #f5ff3d (yellow): R=F5 G=FF B=3D → ASS &HAABBGGRR = &H003DFFF5
const YELLOW = '&H003DFFF5';
const WHITE  = '&H00E6F0F4';

// Vertical/shorts header — 1080×1920, larger, same yellow
const VERTICAL_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 1

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Impact,82,${YELLOW},${YELLOW},&H00000000,&HCC000000,-1,0,0,0,100,100,0,0,1,5,0,2,10,10,340,1
Style: Hot,Impact,82,${WHITE},${WHITE},&H00000000,&HCC000000,-1,0,0,0,100,100,0,0,1,5,0,2,10,10,340,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

// Generate vertical/shorts ASS — all phrases, word-by-word progressive reveal
// anchorY: if set, positions text with \an5\pos(540, anchorY) — middle at that Y (for split mode junction)
function genVerticalAss(words, header, offset = 0, anchorY = null) {
  if (!words || words.length === 0) return header;
  const phrases = groupIntoPhrases(words);

  // Collect all events first, then clip overlaps
  const events = [];
  for (const phraseWords of phrases) {
    const accumulated = [];
    for (let i = 0; i < phraseWords.length; i++) {
      accumulated.push(phraseWords[i]);
      const startT = phraseWords[i].start + offset;
      const endT   = i < phraseWords.length - 1
        ? phraseWords[i + 1].start + offset
        : phraseWords[i].end + offset + 0.15;

      if (endT > startT + 0.04) {
        const text  = accumulated.map(w => w.word.trim().toUpperCase()).join(' ');
        const hot   = isHot(phraseWords[i].word.trim());
        events.push({ startT, endT, text, style: hot ? 'Hot' : 'Default' });
      }
    }
  }

  // Sort by start and clip each event's end to the next event's start
  events.sort((a, b) => a.startT - b.startT);
  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].endT > events[i + 1].startT) {
      events[i].endT = events[i + 1].startT;
    }
  }

  const pos = anchorY != null ? `{\\an5\\pos(540,${anchorY})}` : `{\\an2}`;
  const lines = [header];
  for (const ev of events) {
    if (ev.endT > ev.startT + 0.01) {
      lines.push(`Dialogue: 0,${toAssTime(ev.startT)},${toAssTime(ev.endT)},${ev.style},,0,0,0,,${pos}${ev.text}`);
    }
  }

  return lines.join('\n');
}

// --- Per-clip ASS ---
console.log(`\n=== gen-captions.js ===\n`);

const clipIds = plan.shortClipIds || [];
let generated = 0;

for (const clipId of clipIds) {
  const transcriptPath = path.join(projectDir, 'processed', clipId, 'transcript.json');
  if (!fs.existsSync(transcriptPath)) { console.log(`[SKIP] No transcript: ${clipId}`); continue; }

  const tr = readJson(transcriptPath);
  if (!tr.words || tr.words.length === 0) { console.log(`[SKIP] No words: ${clipId}`); continue; }

  // captionsOff in editorial.short suppresses captions
  const captionsOff = editorialClips[clipId]?.short?.captionsOff === true;
  if (captionsOff) {
    const assPath = path.join(projectDir, 'processed', clipId, 'captions-vertical.ass');
    if (fs.existsSync(assPath)) fs.unlinkSync(assPath);
    console.log(`[SKIP] captions OFF: ${clipId}`);
    continue;
  }

  // For split mode: position captions at webcam/gameplay junction
  let anchorY = null;
  const shortData = editorialClips[clipId]?.short;
  if (shortData?.mode === 'split') {
    const ratio = shortData?.split?.ratio ?? 0.7;
    const gameH = Math.round(1920 * ratio);
    const camH  = 1920 - gameH;
    anchorY = camH;
  }

  const vAss = genVerticalAss(tr.words, VERTICAL_HEADER, 0, anchorY);
  fs.writeFileSync(path.join(projectDir, 'processed', clipId, 'captions-vertical.ass'), vAss, 'utf8');

  const phrases = groupIntoPhrases(tr.words);
  generated++;
  console.log(`[OK] ${clipId} — ${tr.words.length} words, ${phrases.length} phrases`);
}

console.log(`\n[DONE] Generated ${generated} shorts captions\n`);
