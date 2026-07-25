'use strict';
// extract-frames.js — 3 ключові кадри з clean.mp4 навколо аудіо-піку
// Output: processed/<clipId>/frames/frame-1.jpg, frame-2.jpg, frame-3.jpg (JPEG 1280×720)
// Clips processed in parallel (CONCURRENCY = 4).
// Usage: node scripts/extract-frames.js <projectDir>

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readJson, updateState } = require('./lib/state');
const { analyzeRms, findPeak } = require('./lib/audio-peaks');
const { getDuration } = require('./lib/media-probe');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node extract-frames.js <projectDir>'); process.exit(1); }

require('./progress').step(projectDir, 8, 'Ключові кадри');

const plan    = readJson(path.join(projectDir, 'edit/episode-plan.json'));
const clipIds = (plan.clipOrder || []).filter(id => !String(id).startsWith('__'));

const CONCURRENCY = 4;

function extractFrameAsync(input, timestamp, output) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-ss', String(Math.max(0, timestamp)),
      '-i', input,
      '-frames:v', '1',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
      '-q:v', '3',
      '-update', '1',
      '-y', output
    ], { stdio: 'pipe' });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

console.log(`\n=== extract-frames.js — ${projectDir} ===\n`);

let ok = 0, skip = 0;

async function processClip(clipId) {
  const cleanPath = path.join(projectDir, 'processed', clipId, 'clean.mp4');
  if (!fs.existsSync(cleanPath)) {
    console.log(`[SKIP] no clean.mp4: ${clipId.slice(0, 30)}`);
    skip++;
    return;
  }

  const framesDir    = path.join(projectDir, 'processed', clipId, 'frames');
  const editHashFile = path.join(projectDir, 'processed', clipId, 'edit-hash.txt');
  const frmsHashFile = path.join(framesDir, 'frames-hash.txt');
  const frame1       = path.join(framesDir, 'frame-1.jpg');

  if (fs.existsSync(frame1)) {
    const editHash = fs.existsSync(editHashFile) ? fs.readFileSync(editHashFile, 'utf8').trim() : '';
    const frmsHash = fs.existsSync(frmsHashFile) ? fs.readFileSync(frmsHashFile, 'utf8').trim() : '';
    if (editHash && editHash === frmsHash) {
      console.log(`[CACHE] ${clipId.slice(0, 30)}`);
      ok++;
      return;
    }
  }

  fs.mkdirSync(framesDir, { recursive: true });

  const dur = getDuration(cleanPath);
  if (dur < 2) {
    console.log(`[SKIP] too short (${dur.toFixed(1)}s): ${clipId.slice(0, 30)}`);
    skip++;
    return;
  }

  const windows = analyzeRms(cleanPath);
  const peak    = findPeak(windows, { skipStart: 0.5, skipEnd: 1.0 });

  let timestamps;
  if (peak) {
    const p = peak.t;
    timestamps = [
      Math.max(0.3, p - 1.5),
      p,
      Math.min(dur - 0.3, p + 2.0),
    ];
    console.log(`[FRAMES] ${clipId.slice(0, 28)} peak=${p.toFixed(1)}s (${peak.rms.toFixed(0)}dB)`);
  } else {
    timestamps = [dur * 0.25, dur * 0.5, dur * 0.75];
    console.log(`[FRAMES] ${clipId.slice(0, 28)} fallback 25/50/75%`);
  }

  const results = await Promise.all(
    timestamps.map((t, i) => extractFrameAsync(cleanPath, t, path.join(framesDir, `frame-${i + 1}.jpg`)))
  );

  const allOk = results.every(Boolean);
  if (!allOk) {
    results.forEach((ok, i) => { if (!ok) console.error(`  [ERR] frame-${i + 1}`); });
  }

  if (allOk) {
    if (fs.existsSync(editHashFile)) {
      fs.writeFileSync(frmsHashFile, fs.readFileSync(editHashFile, 'utf8'));
    }
    ok++;
  } else skip++;
}

async function main() {
  console.log(`Processing ${clipIds.length} clips (concurrency: ${CONCURRENCY})\n`);
  let i = 0;
  async function worker() {
    while (i < clipIds.length) {
      await processClip(clipIds[i++]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, clipIds.length) }, worker));

  updateState(projectDir, s => {
    s.stages = s.stages || {};
    s.stages.extractFrames = ok > 0 ? 'done' : 'failed';
  });

  console.log(`\nDone. ${ok} ok, ${skip} skipped.\n`);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
