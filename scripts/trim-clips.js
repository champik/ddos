#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node trim-clips.js <projectDir>'); process.exit(1); }

const plan = JSON.parse(fs.readFileSync(path.join(projectDir, 'edit/episode-plan.json'), 'utf8'));
const downloads = JSON.parse(fs.readFileSync(path.join(projectDir, 'clips/downloaded-clips.json'), 'utf8'));

const allIds = [...plan.clipOrder];
if (plan.chillPlan && plan.chillPlan.singingClipId) allIds.push(plan.chillPlan.singingClipId);

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

for (const clipId of allIds) {
  const localPath = getLocalPath(clipId);
  if (!localPath || !fs.existsSync(localPath)) {
    console.log(`  [SKIP] ${clipId.slice(0, 30)} — no video file`);
    errors++;
    continue;
  }

  const cleanPath = path.join(projectDir, 'processed', clipId, 'clean.mp4');
  if (fs.existsSync(cleanPath)) {
    console.log(`  [CACHE] ${clipId.slice(0, 30)}`);
    skipped++;
    continue;
  }

  process.stdout.write(`  [TRIM] ${clipId.slice(0, 30).padEnd(30)} `);

  const { start, end, totalDur } = detectSilence(localPath);
  const trimDur = end - start;

  if (trimDur < 2) {
    console.log(`SKIP (trimDur=${trimDur.toFixed(1)}s too short)`);
    errors++;
    continue;
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
  } else {
    const err = (r.stderr || '').split('\n').filter(l => /error/i.test(l)).slice(-2).join(' ');
    console.log(`FAIL: ${err.slice(0, 100)}`);
    errors++;
  }
}

// Update state
const statePath = path.join(projectDir, 'state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.stages.trim = errors === allIds.length ? 'failed' : 'done';
state.stages.effects = 'skip';
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log(`\nTrim: ${done} done, ${skipped} cached, ${errors} errors`);
