'use strict';
// gen-captions.js — phrase-based ASS captions from transcripts
// Shorts: all phrases, word-by-word reveal within each phrase
// Usage:
//   node scripts/gen-captions.js <projectDir>               — all clips in clipOrder
//   node scripts/gen-captions.js <projectDir> --shorts-only — only shortClipIds, no episode.ass

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectDir = process.argv[2];
const shortsOnly = process.argv.includes('--shorts-only');
if (!projectDir) { console.error('Usage: node gen-captions.js <projectDir> [--shorts-only]'); process.exit(1); }

require('./progress').step(projectDir, 9, shortsOnly ? 'Субтитри для шортсів' : 'Субтитри ASS');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
const plan   = readJson(path.join(projectDir, 'edit/episode-plan.json'));
const scored = readJson(path.join(projectDir, 'clips/scored-clips.json'));

// Game IDs where subtitles add little value unless the clip is very funny
const GAMING_IDS = new Set(['32399','516575','32982','18122','21779','27471','33214','493057']);
const CHAT_IDS   = new Set(['509658','509672']); // Just Chatting, IRL

const scoreMap = {};
for (const c of scored) scoreMap[c.id] = c;

function longformCaptionsEnabled(clipId) {
  const c = scoreMap[clipId];
  if (!c) return true; // unknown → include
  const gameId = String(c.game_id || '');
  if ((c.musicRisk || 0) > 60) return false;         // music-heavy → skip
  if (CHAT_IDS.has(gameId))    return true;           // Just Chatting / IRL → always on
  if (GAMING_IDS.has(gameId))  return (c.funnyScore || 0) > 65; // gaming → only if very funny
  return (c.funnyScore || 0) > 60;                   // other → threshold
}

// Hot words trigger emotional highlight
const HOT = new Set(['no','bro','what','wait','oh','stop','go','yes','wtf','literally',
  'insane','crazy','nah','holy','hell','wow','bruh','yo','omg','damn','actually',
  'really','seriously','bro','dude','man','guys','let','go','come','look','watch']);

function isHot(word) {
  return HOT.has(word.replace(/[^a-z]/g, '').toLowerCase());
}

function toAssTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

// Group words into natural phrases (max 5 words, split on long pauses or punctuation)
function groupIntoPhrases(words) {
  const phrases = [];
  let current = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = current[current.length - 1];
    const gap = prev ? w.start - prev.end : 0;
    const prevText = prev ? prev.word.trim() : '';

    // Break phrase on: long pause, sentence-ending punctuation, or max length
    const longPause = gap > 0.55;
    const sentenceEnd = /[.!?]$/.test(prevText);
    const tooLong = current.length >= 5;

    if (current.length > 0 && (longPause || sentenceEnd || tooLong)) {
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

// Longform header — 1920×1080, Impact 72px, yellow, heavy outline
const LONGFORM_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 1

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Impact,72,${YELLOW},${YELLOW},&H00000000,&HCC000000,-1,0,0,0,100,100,0,0,1,4,0,2,10,10,100,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

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

// Generate longform ASS — emotional phrases only, shown as whole phrase
function genLongformAss(words, header, offset = 0) {
  if (!words || words.length === 0) return header;
  const phrases = groupIntoPhrases(words);
  const lines = [header];

  for (const phraseWords of phrases) {
    if (!isEmotional(phraseWords)) continue;

    const startT = phraseWords[0].start + offset;
    const endT   = phraseWords[phraseWords.length - 1].end + offset + 0.1;
    const text   = phraseWords.map(w => w.word.trim().toUpperCase()).join(' ');

    if (endT > startT + 0.1) {
      lines.push(`Dialogue: 0,${toAssTime(startT)},${toAssTime(endT)},Default,,0,0,0,,{\\an2}${text}`);
    }
  }

  return lines.join('\n');
}

// Generate vertical/shorts ASS — all phrases, word-by-word progressive reveal
function genVerticalAss(words, header, offset = 0) {
  if (!words || words.length === 0) return header;
  const phrases = groupIntoPhrases(words);
  const lines = [header];

  for (const phraseWords of phrases) {
    // Progressive reveal: show phrase with each additional word at its timestamp
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
        const style = hot ? 'Hot' : 'Default';
        lines.push(`Dialogue: 0,${toAssTime(startT)},${toAssTime(endT)},${style},,0,0,0,,{\\an2}${text}`);
      }
    }
  }

  return lines.join('\n');
}

function getDuration(filePath) {
  try {
    return parseFloat(
      execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`).toString().trim()
    ) || 0;
  } catch { return 0; }
}

// --- Per-clip ASS ---
console.log('\n=== gen-captions.js' + (shortsOnly ? ' (shorts-only)' : '') + ' ===\n');

// In shorts-only mode process only shortClipIds; otherwise all clips in clipOrder
const clipIds = shortsOnly
  ? (plan.shortClipIds || [])
  : plan.clipOrder;

let generated = 0;
for (const clipId of clipIds) {
  const transcriptPath = path.join(projectDir, 'processed', clipId, 'transcript.json');
  if (!fs.existsSync(transcriptPath)) { console.log(`[SKIP] No transcript: ${clipId}`); continue; }

  const tr = readJson(transcriptPath);
  if (!tr.words || tr.words.length === 0) { console.log(`[SKIP] No words: ${clipId}`); continue; }

  const enableLongform = longformCaptionsEnabled(clipId);
  const lfAss = enableLongform
    ? genLongformAss(tr.words, LONGFORM_HEADER)
    : LONGFORM_HEADER; // empty — no dialogue lines
  fs.writeFileSync(path.join(projectDir, 'processed', clipId, 'captions-longform.ass'), lfAss, 'utf8');

  const vAss = genVerticalAss(tr.words, VERTICAL_HEADER);
  fs.writeFileSync(path.join(projectDir, 'processed', clipId, 'captions-vertical.ass'), vAss, 'utf8');

  const phrases = groupIntoPhrases(tr.words);
  const emotional = phrases.filter(isEmotional).length;
  const lfTag = enableLongform ? `${emotional} emotional` : 'captions OFF';
  generated++;
  console.log(`[OK] ${clipId} — ${tr.words.length} words, ${phrases.length} phrases (${lfTag})`);
}

if (shortsOnly) {
  console.log(`\n[DONE] Generated ${generated} shorts captions (vertical only, no episode.ass)\n`);
} else {
  // --- Merge episode.ass (full mode only — will be deleted before longform render) ---
  const INTRO_DUR = 1.25;
  const RECONNECT_DUR = 1.0;

  let offset = INTRO_DUR;
  const episodeLines = [LONGFORM_HEADER];

  for (let gi = 0; gi < plan.groups.length; gi++) {
    const group = plan.groups[gi];
    for (const clipId of group.clipIds) {
      const transcriptPath = path.join(projectDir, 'processed', clipId, 'transcript.json');
      if (fs.existsSync(transcriptPath)) {
        const tr = readJson(transcriptPath);
        if (tr.words && tr.words.length > 0) {
          const ass = genLongformAss(tr.words, '', offset);
          episodeLines.push(...ass.split('\n').filter(l => l.startsWith('Dialogue:')));
        }
      }
      const cleanPath = path.join(projectDir, 'processed', clipId, 'clean.mp4');
      offset += getDuration(cleanPath);
    }
    if (gi < plan.groups.length - 1) offset += RECONNECT_DUR;
  }

  fs.writeFileSync(path.join(projectDir, 'edit/episode.ass'), episodeLines.join('\n'), 'utf8');
  console.log(`\n[DONE] Generated ${generated} clip captions + episode.ass\n`);
}
