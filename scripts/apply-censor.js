#!/usr/bin/env node
'use strict';
// apply-censor.js <projectDir>
// Mutes Tier 1/2 profanity (auto-detected from transcript.json word timestamps,
// plus editor-added manualMutes from editorial.json) in processed/<clipId>/clean.mp4,
// overlaying assets/sounds/glitch.wav in the gap. Overwrites clean.mp4 in place so
// every downstream stage (overlays, build-concat, render-shorts) inherits the
// censored audio without any changes on their end.
//
// See docs/superpowers/specs/2026-07-26-profanity-censorship-design.md

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');
const { readJson, readJsonSafe, updateState, stageStatus } = require('./lib/state');
const { getDurationAsync } = require('./lib/media-probe');
const { normalizeWord, isProfane, maskWord } = require('./lib/profanity');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node scripts/apply-censor.js <projectDir>'); process.exit(1); }

require('./progress').step(projectDir, '8b', 'Цензура матюків');

const GLITCH_PATH = path.resolve('assets/sounds/glitch.wav');
const GLITCH_VOLUME = 0.5; // glitch overlay mixed in at half volume
const PAD = 0.04; // secs of extra mute on each side of a detected word, clamped to neighbors

const editorialPath = path.join(projectDir, 'edit', 'editorial.json');
if (!fs.existsSync(editorialPath)) {
  console.error('editorial.json not found:', editorialPath);
  process.exit(1);
}
const editorial = readJson(editorialPath);
const editorialClips = editorial.clips || {};

const CONCURRENCY = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));

function ffmpegAsync(args) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => resolve({ status: code, stderr }));
    proc.on('error', e => resolve({ status: -1, stderr: e.message }));
  });
}

// Builds the list of [start,end] mute windows for one clip: auto-detected
// profane words (padded, clamped so they never bleed into a neighboring
// word) plus any editor-added manual marks (centered on the click timestamp,
// width = glitch duration by default — matches edit.html's browser-preview
// window exactly, so the segment the editor heard muted is the same one that
// gets cut here. A mark can override this with its own `dur` (seconds) when
// it wasn't placed against that preview — e.g. a timestamp given without
// having heard the exact word length — and the default 0.28s risks leaving
// part of a longer word audible at the edges.
function buildMuteWindows(words, manualMutes, clipDuration, glitchDuration) {
  const hits = [];
  (words || []).forEach((w, i) => {
    if (!isProfane(normalizeWord(w.word))) return;
    const prevEnd = i > 0 ? words[i - 1].end : 0;
    const nextStart = i < words.length - 1 ? words[i + 1].start : clipDuration;
    const start = Math.max(prevEnd, w.start - PAD);
    const end = Math.min(nextStart, w.end + PAD);
    if (end <= start) return;
    hits.push({ word: w.word, masked: maskWord(w.word), start, end, source: 'auto' });
  });
  (manualMutes || []).forEach(m => {
    const half = (m.dur != null ? m.dur : glitchDuration) / 2;
    const start = Math.max(0, m.at - half);
    const end = Math.min(clipDuration, m.at + half);
    if (end <= start) return;
    hits.push({ word: null, masked: null, start, end, source: 'manual' });
  });
  hits.sort((a, b) => a.start - b.start);
  return mergeWindows(hits);
}

// Merges overlapping/touching windows (next.start <= current.end) into one,
// spanning [start, max(end)]. Two full-amplitude glitch.wav mixes landing on
// the same time range (e.g. a manual mute overlapping an auto-detected word)
// would otherwise sum past 0dB in amix — merge first so there's only ever one
// glitch layer per time range. Prefers an 'auto' hit's word/masked/source for
// the merged entry (more useful in the audit log than a manual mark's nulls);
// if both sides are the same source, keeps the first one's.
function mergeWindows(hits) {
  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.start <= last.end) {
      last.end = Math.max(last.end, h.end);
      if (h.source === 'auto' && last.source !== 'auto') {
        last.word = h.word;
        last.masked = h.masked;
        last.source = h.source;
      }
    } else {
      merged.push({ ...h });
    }
  }
  return merged;
}

function windowsHash(windows) {
  const src = JSON.stringify(windows.map(w => [w.start, w.end, w.source]));
  return crypto.createHash('md5').update(src).digest('hex');
}

// One ffmpeg pass: mute the original audio during every window, and mix in
// glitch.wav (trimmed to each window's own duration, so it never bleeds past
// the muted word into the next one) at the same offsets. Video is untouched.
async function censorAudio(cleanPath, tmpPath, windows) {
  const muteExpr = windows.map(w => `between(t,${w.start.toFixed(3)},${w.end.toFixed(3)})`).join('+');
  const filterParts = [`[0:a]volume=0:enable='${muteExpr}'[muted]`];
  const asplitLabels = windows.map((_, i) => `[gin${i}]`).join('');
  filterParts.push(`[1:a]asplit=${windows.length}${asplitLabels}`);
  windows.forEach((w, i) => {
    const delayMs = (w.start * 1000).toFixed(0);
    filterParts.push(`[gin${i}]atrim=0:${(w.end - w.start).toFixed(3)},adelay=${delayMs}|${delayMs},volume=${GLITCH_VOLUME}[g${i}]`);
  });
  const mixInputs = ['[muted]', ...windows.map((_, i) => `[g${i}]`)].join('');
  filterParts.push(`${mixInputs}amix=inputs=${windows.length + 1}:duration=first:dropout_transition=0:normalize=0[outa]`);

  const args = [
    '-i', cleanPath,
    '-i', GLITCH_PATH,
    '-filter_complex', filterParts.join(';'),
    '-map', '0:v', '-map', '[outa]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-y', tmpPath,
  ];
  const result = await ffmpegAsync(args);
  if (result.status !== 0) {
    const lines = (result.stderr || '').split('\n').map(l => l.trim()).filter(l => /error/i.test(l));
    if (lines.length) console.error('  FFmpeg:\n  ' + lines.slice(0, 3).join('\n  '));
    return { ok: false, error: lines[0] || `ffmpeg exited with code ${result.status}` };
  }
  return { ok: true };
}

let processed = 0, skipped = 0, failed = 0;
const failures = []; // { clipId, reason } — surfaced into state.warnings so AUTONOMOUS MODE keeps going but the failure isn't silent

async function censorClip(clipId, glitchDuration) {
  const outDir = path.join(projectDir, 'processed', clipId);
  const cleanPath = path.join(outDir, 'clean.mp4');
  const hashPath = path.join(outDir, 'censor-hash.txt');
  const logPath = path.join(outDir, 'censor-log.json');

  if (!fs.existsSync(cleanPath)) { console.warn('SKIP (no clean.mp4):', clipId); skipped++; return; }

  const clipEdits = editorialClips[clipId] || {};
  const transcriptPath = path.join(outDir, 'transcript.json');
  const transcript = readJsonSafe(transcriptPath, null);
  // manualMutesOnly: transcript word-level auto-detection can be too noisy on some
  // clips (e.g. overlapping/duplicate segments producing repeat false triggers) —
  // editor can opt a clip out of auto-detection entirely and rely only on their
  // own 🔇 marks from edit.html.
  const words = clipEdits.manualMutesOnly ? [] : (transcript?.words || []);
  const manualMutes = clipEdits.manualMutes || [];

  const clipDuration = await getDurationAsync(cleanPath);

  const windows = buildMuteWindows(words, manualMutes, clipDuration, glitchDuration);
  const currentHash = windowsHash(windows);
  const cachedHash = fs.existsSync(hashPath) ? fs.readFileSync(hashPath, 'utf8').trim() : null;

  if (cachedHash === currentHash && fs.existsSync(logPath)) {
    console.log('CACHED:', clipId, `(${windows.length} mute windows)`);
    skipped++;
    return;
  }

  if (windows.length === 0) {
    fs.writeFileSync(logPath, JSON.stringify([], null, 2));
    fs.writeFileSync(hashPath, currentHash, 'utf8');
    console.log('CLEAN (no profanity):', clipId);
    skipped++;
    return;
  }

  const tmpPath = path.join(outDir, 'clean.censor-tmp.mp4');
  console.log(`CENSOR: ${clipId} — ${windows.length} window(s): ${windows.map(w => w.word || 'manual').join(', ')}`);
  const result = await censorAudio(cleanPath, tmpPath, windows);

  if (!result.ok) {
    fs.rmSync(tmpPath, { force: true });
    console.error('FAILED:', clipId);
    failed++;
    failures.push({ clipId, reason: result.error });
    return;
  }

  fs.renameSync(tmpPath, cleanPath);
  fs.writeFileSync(logPath, JSON.stringify(
    windows.map(w => ({ word: w.word, masked: w.masked, start: +w.start.toFixed(2), end: +w.end.toFixed(2), source: w.source })),
    null, 2
  ));
  fs.writeFileSync(hashPath, currentHash, 'utf8');
  console.log('OK:', clipId);
  processed++;
}

async function main() {
  const clipIds = (editorial.clipOrder || []).filter(id => !String(id).startsWith('__recon'));
  console.log(`\n=== apply-censor.js — ${projectDir} (${clipIds.length} clips, concurrency: ${CONCURRENCY}) ===\n`);

  // Probed once — only manual-mute windows need it (fixed length = glitch
  // duration), so re-probing per clip was wasted ffprobe spawns on every run.
  const glitchDuration = await getDurationAsync(GLITCH_PATH);

  let i = 0;
  async function worker() {
    while (i < clipIds.length) {
      await censorClip(clipIds[i++], glitchDuration);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, clipIds.length) }, worker));

  console.log(`\nDone: ${processed} censored, ${skipped} skipped, ${failed} failed`);

  updateState(projectDir, s => {
    s.stages = s.stages || {};
    s.stages.censor = stageStatus(processed + skipped, failed);
    if (failures.length > 0) {
      s.warnings = s.warnings || [];
      s.warnings.push(...failures.map(f => `censor: ${f.reason} (${f.clipId})`));
    }
  });
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
