#!/usr/bin/env node
// apply-editorial.js <runId>
// Copies each selected clip to clean.mp4 at FULL original length (re-encoded
// for consistent CRF/fps/loudness) — no trim/cuts. editorial.json's
// clipOrder decides WHICH clips and in what ORDER; actual cutting happens
// later by hand in CapCut (selection-only pipeline).
// Clips are processed in parallel (CONCURRENCY = half of available CPU cores).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');
const { readJson, updateState, stageStatus } = require('./lib/state');
const { getProjectDir } = require('./lib/project-path');
const { LOUDNORM_TARGET, measureLoudness, buildLoudnormFilter } = require('./lib/audio-loudness');
const { SILENCE_DB, hasAudioStreamAsync } = require('./lib/media-probe');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node scripts/apply-editorial.js <runId>'); process.exit(1); }

const projectDir = getProjectDir(runId);
const editorialPath = path.join(projectDir, 'edit', 'editorial.json');
const downloadedPath = path.join(projectDir, 'clips', 'downloaded-clips.json');

if (!fs.existsSync(editorialPath)) {
  console.error('editorial.json not found:', editorialPath);
  process.exit(1);
}

const editorial = readJson(editorialPath);
const downloaded = readJson(downloadedPath);

const dlMap = {};
downloaded.forEach(c => { dlMap[c.id] = c; });

const { buildBasenameMap, processedTypeDir } = require('./lib/clip-naming');
const basenames = buildBasenameMap(editorial.clipOrder, downloaded);
const CLEAN_DIR = processedTypeDir(projectDir, 'clean');
fs.mkdirSync(CLEAN_DIR, { recursive: true });

const CONCURRENCY = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));

function editsHash(clipEdits) {
  const src = JSON.stringify({ audio: clipEdits.skipLoudnorm ? 'skip' : `loudnorm=${LOUDNORM_TARGET}` });
  return crypto.createHash('md5').update(src).digest('hex');
}

function ffmpegAsync(args) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => resolve({ status: code, stderr }));
    proc.on('error', e => resolve({ status: -1, stderr: e.message }));
  });
}

// CRF 18 — clean.mp4 is the CapCut handoff source, its quality IS the final quality.
async function encodeFull({ src, outPath, hasAudio, audioFilter }) {
  const inputs = ['-i', src];
  if (!hasAudio) inputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  const audioInput = hasAudio ? 0 : 1;

  const af = hasAudio
    ? ['-af', audioFilter ? `asetpts=PTS-STARTPTS,${audioFilter}` : 'asetpts=PTS-STARTPTS']
    : [];

  const args = [
    ...inputs,
    '-map', '0:v', '-map', `${audioInput}:a`,
    ...(hasAudio ? [] : ['-shortest']),
    '-vf', 'setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1',
    ...af,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-r', '30',
    '-y', outPath
  ];

  const result = await ffmpegAsync(args);
  if (result.status !== 0) {
    const lines = (result.stderr || '').split('\n');
    const errors = lines.filter(l => /error/i.test(l));
    if (errors.length) console.error('  FFmpeg:\n  ' + errors.slice(0, 3).join('\n  '));
  }
  return result.status === 0;
}

let processed = 0, skipped = 0, failed = 0;

async function processClip(clipId) {
  const dlClip = dlMap[clipId];
  if (!dlClip) { console.warn('SKIP (not in downloaded):', clipId); skipped++; return; }

  const src = dlClip.localPath;
  if (!fs.existsSync(src)) { console.warn('SKIP (file missing):', src); skipped++; return; }

  const basename = basenames[clipId];
  if (!basename) { console.warn('SKIP (not in clipOrder):', clipId); skipped++; return; }
  const outPath = path.join(CLEAN_DIR, `${basename}.mp4`);
  const hashPath = path.join(CLEAN_DIR, `${basename}.edit-hash.txt`);

  const clipEdits = editorial.clips?.[clipId] || {};
  const currentHash = editsHash(clipEdits);

  const cachedHash = fs.existsSync(hashPath) ? fs.readFileSync(hashPath, 'utf8').trim() : null;
  if (fs.existsSync(outPath) && cachedHash === currentHash) {
    console.log('CACHED:', clipId);
    skipped++;
    return;
  }

  const hasAudio = await hasAudioStreamAsync(src);
  const measured = hasAudio ? await measureLoudness(src) : null;
  const audioFilter = (hasAudio && !clipEdits.skipLoudnorm) ? buildLoudnormFilter(measured) : null;
  if (!hasAudio) console.warn(`  [NO AUDIO] ${clipId} — додаю тишу (anullsrc)`);

  // Німа доріжка ≠ відсутня доріжка: заглушений або битий кліп має аудіо-стрім,
  // просто порожній. input_i вже виміряний для loudnorm, тож перевірка безкоштовна.
  if (hasAudio && measured) {
    const inputI = parseFloat(measured.input_i);
    if (!isFinite(inputI) || inputI <= SILENCE_DB) {
      console.warn(`  [SILENT] ${clipId} — доріжка є, але вона німа (${measured.input_i} LUFS)`);
    }
  }

  console.log(`PROCESS: ${clipId} (full length, loudnorm=${audioFilter ? 'attenuate' : 'skip'})`);
  const ok = await encodeFull({ src, outPath, hasAudio, audioFilter });

  if (!ok) { console.error('FAILED:', clipId); failed++; return; }

  fs.writeFileSync(hashPath, currentHash, 'utf8');
  console.log('OK:', clipId);
  processed++;
}

async function main() {
  const clipIds = editorial.clipOrder.filter(id => !String(id).startsWith('__recon'));
  console.log(`\nProcessing ${clipIds.length} clips at full length (concurrency: ${CONCURRENCY})\n`);

  let i = 0;
  async function worker() {
    while (i < clipIds.length) {
      await processClip(clipIds[i++]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, clipIds.length) }, worker));

  console.log(`\nDone: ${processed} processed, ${skipped} skipped, ${failed} failed`);

  updateState(projectDir, s => {
    s.stages = s.stages || {};
    s.stages.trim = stageStatus(processed + skipped, failed);
  });

  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
