#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Modes:
//   (default)        trim clips from episode-plan.json clipOrder
//   --incremental    trim top clips by ddosScore until episode duration >= target
//                    expands in batches of 10, stops if ddosScore drops below floor
//   --all            trim every clip in downloaded-clips.json

const TARGET_MIN = 720;   // 12 min minimum episode duration
const TARGET_MAX = 900;   // 15 min cap
const BATCH_INIT = 30;    // first batch: top 30 by ddosScore
const BATCH_SIZE = 10;    // expand by 10 each round
const SCORE_FLOOR = 45;   // never add clips below this ddosScore

const projectDir = process.argv[2];
const trimAll = process.argv.includes('--all');
const incremental = process.argv.includes('--incremental');
if (!projectDir) { console.error('Usage: node trim-clips.js <projectDir> [--incremental|--all]'); process.exit(1); }

const downloads = JSON.parse(fs.readFileSync(path.join(projectDir, 'clips/downloaded-clips.json'), 'utf8'));

let allIds;
if (trimAll) {
  allIds = downloads.map(c => c.id);
  console.log(`--all: trimming all ${allIds.length} downloaded clips`);
} else if (incremental) {
  // Load scored clips sorted by ddosScore descending
  const scoredPath = path.join(projectDir, 'clips/scored-clips.json');
  const scored = JSON.parse(fs.readFileSync(scoredPath, 'utf8'))
    .sort((a, b) => (b.ddosScore || 0) - (a.ddosScore || 0));

  console.log(`--incremental: target ${TARGET_MIN}–${TARGET_MAX}s, floor ddosScore≥${SCORE_FLOOR}`);
  console.log(`  Starting with top ${BATCH_INIT} clips, expanding by ${BATCH_SIZE} if needed\n`);

  // Incrementally build allIds until enough duration or floor hit
  allIds = [];
  let cursor = 0;
  const batchSize = (cursor === 0) ? BATCH_INIT : BATCH_SIZE;

  // We'll trim incrementally below — just build the full candidate list here,
  // then the trim loop checks total duration after each batch
  const candidates = scored.filter(c => (c.ddosScore || 0) >= SCORE_FLOOR);
  const belowFloor = scored.filter(c => (c.ddosScore || 0) < SCORE_FLOOR);
  console.log(`  Candidates above floor: ${candidates.length}, below floor: ${belowFloor.length}`);
  allIds = candidates.map(c => c.id); // trim loop will handle batching
} else {
  const plan = JSON.parse(fs.readFileSync(path.join(projectDir, 'edit/episode-plan.json'), 'utf8'));
  allIds = [...plan.clipOrder];
  if (plan.chillPlan && plan.chillPlan.singingClipId) allIds.push(plan.chillPlan.singingClipId);
}

function getLocalPath(clipId) {
  const clip = downloads.find(c => c.id === clipId);
  return clip ? clip.localPath : null;
}

function getDuration(filePath) {
  const r = spawnSync('ffprobe', [
    '-v', 'quiet', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', filePath
  ], { encoding: 'utf8' });
  return parseFloat(r.stdout.trim()) || 0;
}

function detectSilence(filePath) {
  const r = spawnSync('ffmpeg', [
    '-i', filePath,
    '-af', 'silencedetect=noise=-40dB:duration=0.3',
    '-f', 'null', '-'
  ], { encoding: 'utf8', stdio: 'pipe' });

  const output = (r.stderr || '') + (r.stdout || '');
  const silenceEnds = [...output.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
  const silenceStarts = [...output.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));

  const totalDur = getDuration(filePath);
  const start = silenceEnds.length > 0 ? Math.max(0, silenceEnds[0] - 0.1) : 0;
  const end = silenceStarts.length > 0 ? Math.min(totalDur, silenceStarts[silenceStarts.length - 1] + 0.1) : totalDur;

  return { start, end, totalDur };
}

let done = 0, skipped = 0, errors = 0;

function trimClip(clipId) {
  const localPath = getLocalPath(clipId);
  if (!localPath || !fs.existsSync(localPath)) {
    console.log(`  [SKIP] ${clipId.slice(0, 30)} — no video file`);
    errors++;
    return 0;
  }

  const cleanPath = path.join(projectDir, 'processed', clipId, 'clean.mp4');
  if (fs.existsSync(cleanPath)) {
    const d = getDuration(cleanPath);
    console.log(`  [CACHE] ${clipId.slice(0, 30)} ${d.toFixed(1)}s`);
    skipped++;
    return d;
  }

  process.stdout.write(`  [TRIM] ${clipId.slice(0, 30).padEnd(30)} `);

  const { start, end, totalDur } = detectSilence(localPath);
  const trimDur = end - start;

  if (trimDur < 2) {
    console.log(`SKIP (trimDur=${trimDur.toFixed(1)}s too short)`);
    errors++;
    return 0;
  }

  fs.mkdirSync(path.dirname(cleanPath), { recursive: true });

  const r = spawnSync('ffmpeg', [
    '-i', localPath,
    '-ss', String(start),
    '-to', String(end),
    '-vf', 'setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
    '-af', 'asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-r', '30',
    '-y', cleanPath
  ], { stdio: 'pipe', encoding: 'utf8', timeout: 120000 });

  if (r.status === 0 && fs.existsSync(cleanPath)) {
    const cleanDur = getDuration(cleanPath);
    console.log(`OK ${start.toFixed(1)}s-${end.toFixed(1)}s/${totalDur.toFixed(1)}s → ${cleanDur.toFixed(1)}s`);
    done++;
    return cleanDur;
  } else {
    const err = (r.stderr || '').split('\n').filter(l => /error/i.test(l)).slice(-2).join(' ');
    console.log(`FAIL: ${err.slice(0, 100)}`);
    errors++;
    return 0;
  }
}

if (incremental) {
  // Incremental mode: trim in batches, stop when target duration reached
  let totalDur = 0;
  let cursor = 0;

  const firstBatch = allIds.slice(0, BATCH_INIT);
  cursor = BATCH_INIT;
  console.log(`  Batch 1: trimming top ${firstBatch.length} clips...`);
  for (const id of firstBatch) totalDur += trimClip(id);
  console.log(`  → Total so far: ${totalDur.toFixed(0)}s / ${TARGET_MIN}s needed\n`);

  while (totalDur < TARGET_MIN && cursor < allIds.length) {
    const batch = allIds.slice(cursor, cursor + BATCH_SIZE);
    if (batch.length === 0) break;
    cursor += BATCH_SIZE;
    console.log(`  Expanding: trimming next ${batch.length} clips (total trimmed: ${cursor})...`);
    for (const id of batch) totalDur += trimClip(id);
    console.log(`  → Total so far: ${totalDur.toFixed(0)}s / ${TARGET_MIN}s needed\n`);
  }

  if (totalDur < TARGET_MIN) {
    console.log(`  ⚠ WARNING: only reached ${totalDur.toFixed(0)}s after exhausting clips above score floor ${SCORE_FLOOR}`);
  } else {
    console.log(`  ✓ Target reached: ${totalDur.toFixed(0)}s total clean duration available`);
  }
} else {
  for (const clipId of allIds) trimClip(clipId);
}

// Update state
const statePath = path.join(projectDir, 'state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.stages.trim = errors === allIds.length ? 'failed' : 'done';
state.stages.effects = 'skip';
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log(`\nTrim: ${done} done, ${skipped} cached, ${errors} errors`);
