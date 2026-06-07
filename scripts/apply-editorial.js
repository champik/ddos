#!/usr/bin/env node
// apply-editorial.js <runId>
// Processes clips per editorial.json decisions (trim + cuts) → clean.mp4

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node scripts/apply-editorial.js <runId>'); process.exit(1); }

const projectDir = path.join('projects', runId);
const editorialPath = path.join(projectDir, 'edit', 'editorial.json');
const downloadedPath = path.join(projectDir, 'clips', 'downloaded-clips.json');
const cleanExportDir = path.join(projectDir, 'exports', 'clean');

if (!fs.existsSync(editorialPath)) {
  console.error('editorial.json not found:', editorialPath);
  process.exit(1);
}

const editorial = JSON.parse(fs.readFileSync(editorialPath, 'utf8'));
const downloaded = JSON.parse(fs.readFileSync(downloadedPath, 'utf8'));

const dlMap = {};
downloaded.forEach(c => { dlMap[c.id] = c; });

function fmtSec(sec) { return parseFloat(sec).toFixed(3); }

function buildPlan(src, inT, outT, keeps) {
  // keeps = segments to INCLUDE; if empty → include full range
  const segments = keeps && keeps.length > 0
    ? keeps.map(([s, e]) => [Math.max(s, inT), Math.min(e, outT)]).filter(([s, e]) => e > s)
    : [[inT, outT]];
  if (segments.length === 0) segments.push([inT, outT]);

  if (segments.length === 1) {
    return { simple: true, inT: segments[0][0], outT: segments[0][1] };
  }

  const vParts = [], aParts = [], labels = [];
  const scale = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2';
  segments.forEach(([s, e], i) => {
    vParts.push(`[0:v]trim=start=${fmtSec(s)}:end=${fmtSec(e)},setpts=PTS-STARTPTS,${scale}[v${i}]`);
    aParts.push(`[0:a]atrim=start=${fmtSec(s)}:end=${fmtSec(e)},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  const concat = `${labels.join('')}concat=n=${segments.length}:v=1:a=1[outv][outa]`;
  const loudnorm = `[outa]loudnorm=I=-16:TP=-1.5:LRA=11[louta]`;
  return {
    simple: false,
    filter: [...vParts, ...aParts, concat, loudnorm].join(';'),
    vMap: '[outv]', aMap: '[louta]'
  };
}

let processed = 0, skipped = 0, failed = 0;

for (const clipId of editorial.clipOrder) {
  const dlClip = dlMap[clipId];
  if (!dlClip) { console.warn('SKIP (not in downloaded):', clipId); skipped++; continue; }

  const src = dlClip.localPath;
  if (!fs.existsSync(src)) { console.warn('SKIP (file missing):', src); skipped++; continue; }

  const outDir = path.join(projectDir, 'processed', clipId);
  const outPath = path.join(outDir, 'clean.mp4');

  if (fs.existsSync(outPath)) { console.log('CACHED:', clipId); skipped++; continue; }

  fs.mkdirSync(outDir, { recursive: true });

  const clipEdits = editorial.clips?.[clipId] || {};
  const inT = clipEdits.trim?.in ?? 0;

  const durResult = spawnSync('ffprobe', [
    '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', src
  ], { encoding: 'utf8' });
  const fullDur = parseFloat(durResult.stdout) || 999;
  const outT = clipEdits.trim?.out ?? fullDur;
  const keeps = clipEdits.keeps || [];

  const plan = buildPlan(src, inT, outT, keeps);

  let args;
  if (plan.simple) {
    args = [
      '-i', src,
      '-ss', fmtSec(plan.inT), '-to', fmtSec(plan.outT),
      '-vf', 'setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
      '-af', 'asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-r', '30', '-ac', '2',
      '-y', outPath
    ];
  } else {
    args = [
      '-i', src,
      '-filter_complex', plan.filter,
      '-map', plan.vMap, '-map', plan.aMap,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-r', '30', '-ac', '2',
      '-y', outPath
    ];
  }

  console.log(`PROCESS: ${clipId} (${keeps.length} keeps, range ${fmtSec(inT)}-${fmtSec(outT)})`);
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });

  if (result.status !== 0) { console.error('FAILED:', clipId); failed++; }
  else {
    console.log('OK:', clipId);
    processed++;
    if (editorial.clips?.[clipId]?.short) {
      fs.mkdirSync(cleanExportDir, { recursive: true });
      const dest = path.join(cleanExportDir, clipId + '.mp4');
      fs.copyFileSync(outPath, dest);
      console.log('  → exports/clean/', clipId + '.mp4');
    }
  }
}

console.log(`\nDone: ${processed} processed, ${skipped} skipped, ${failed} failed`);
if (failed > 0) process.exit(1);
