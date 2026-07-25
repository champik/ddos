#!/usr/bin/env node
// apply-editorial.js <runId>
// Processes clips per editorial.json decisions (trim + cuts) → clean.mp4
// Clips are processed in parallel (CONCURRENCY = half of available CPU cores).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');
const { readJson, updateState, stageStatus } = require('./lib/state');
const { getProjectDir } = require('./lib/project-path');
const { LOUDNORM_TARGET, measureLoudness, buildLoudnormFilter } = require('./lib/audio-loudness');
const { SILENCE_DB } = require('./lib/media-probe');

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

const CONCURRENCY = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));

function fmtSec(sec) { return parseFloat(sec).toFixed(3); }

function editsHash(clipEdits) {
  // NOTE: this string must stay byte-identical to the pre-attenuate-only-fix
  // value ('loudnorm=I=-16:TP=-1.5:LRA=11') so caching for clips that don't
  // need the audio fix (measured already <= -16 LUFS, verified via a separate
  // loudness scan) isn't invalidated. The actual filter applied at encode
  // time is decided dynamically per-clip by buildLoudnormFilter() regardless
  // of this string — it's a cache key, not the real filter.
  const src = JSON.stringify({ trim: clipEdits.trim || null, keeps: clipEdits.keeps || [], audio: `loudnorm=${LOUDNORM_TARGET}` });
  return crypto.createHash('md5').update(src).digest('hex');
}

function ffprobeAsync(args) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', args, { stdio: 'pipe' });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => resolve(out.trim()));
    proc.on('error', () => resolve(''));
  });
}

async function hasAudioStream(src) {
  const out = await ffprobeAsync([
    '-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', src
  ]);
  return out.length > 0;
}

async function getVideoDuration(src) {
  const out = await ffprobeAsync([
    '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', src
  ]);
  return parseFloat(out) || 999;
}

function buildPlan(inT, outT, keeps, audioInput, audioFilter) {
  const segments = keeps && keeps.length > 0
    ? keeps.map(([s, e]) => [Math.max(s, inT), Math.min(e, outT)]).filter(([s, e]) => e > s)
    : [[inT, outT]];
  if (segments.length === 0) segments.push([inT, outT]);

  if (segments.length === 1) {
    return { simple: true, inT: segments[0][0], outT: segments[0][1] };
  }

  const vParts = [], aParts = [], labels = [];
  // setsar=1: фінальний епізод клеїться concat -c copy — несквадратний SAR
  // з вихідного кліпу пройшов би крізь scale+pad і зламав геометрію склейки.
  const scale = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1';
  segments.forEach(([s, e], i) => {
    vParts.push(`[0:v]trim=start=${fmtSec(s)}:end=${fmtSec(e)},setpts=PTS-STARTPTS,${scale}[v${i}]`);
    aParts.push(`[${audioInput}:a]atrim=start=${fmtSec(s)}:end=${fmtSec(e)},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  const concat = `${labels.join('')}concat=n=${segments.length}:v=1:a=1[outv][outa]`;
  // No boost policy: skip the loudnorm node entirely when the clip is already
  // quiet enough (audioFilter === null) — mapping [outa] straight through.
  const aMap = audioFilter ? '[louta]' : '[outa]';
  const loudnormNode = audioFilter ? [`[outa]${audioFilter}[louta]`] : [];
  return {
    simple: false,
    filter: [...vParts, ...aParts, concat, ...loudnormNode].join(';'),
    vMap: '[outv]', aMap
  };
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

// CRF 18 для проміжних: clean.mp4 → overlayed.mp4 → concat -c copy,
// тобто якість clean/overlayed і Є якістю фінального епізоду.
async function encodeVariant({ src, outPath, plan, hasAudio, forceFps, audioFilter }) {
  const inputs = ['-i', src];
  if (!hasAudio) {
    inputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }
  const audioInput = hasAudio ? 0 : 1;

  const common = [
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    ...(forceFps ? ['-r', '30'] : []),
    '-y', outPath
  ];

  let args;
  if (plan.simple) {
    const af = hasAudio
      ? ['-af', audioFilter ? `asetpts=PTS-STARTPTS,${audioFilter}` : 'asetpts=PTS-STARTPTS']
      : [];
    args = [
      ...inputs,
      '-ss', fmtSec(plan.inT), '-to', fmtSec(plan.outT),
      '-map', '0:v', '-map', `${audioInput}:a`,
      ...(hasAudio ? [] : ['-shortest']),
      '-vf', 'setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1',
      ...af,
      ...common
    ];
  } else {
    args = [
      ...inputs,
      '-filter_complex', plan.filter,
      '-map', plan.vMap, '-map', plan.aMap,
      ...common
    ];
  }

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

  const outDir = path.join(projectDir, 'processed', clipId);
  const outPath = path.join(outDir, 'clean.mp4');
  const hashPath = path.join(outDir, 'edit-hash.txt');

  const clipEdits = editorial.clips?.[clipId] || {};
  const currentHash = editsHash(clipEdits);

  const cachedHash = fs.existsSync(hashPath) ? fs.readFileSync(hashPath, 'utf8').trim() : null;
  if (fs.existsSync(outPath) && cachedHash === currentHash) {
    console.log('CACHED:', clipId);
    skipped++;
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  const inT = clipEdits.trim?.in ?? 0;
  const fullDur = await getVideoDuration(src);
  const outT = clipEdits.trim?.out ?? fullDur;
  const keeps = clipEdits.keeps || [];
  const hasAudio = await hasAudioStream(src);
  // Той самий набір відрізків, що piде в buildPlan — міряємо лише те, що
  // реально опиниться у відео, а не весь файл разом з вирізаними шматками.
  const measureSegments = (keeps.length > 0
    ? keeps.map(([s, e]) => [Math.max(s, inT), Math.min(e, outT)]).filter(([s, e]) => e > s)
    : [[inT, outT]]);
  const measured = hasAudio ? await measureLoudness(src, { segments: measureSegments }) : null;
  const audioFilter = hasAudio ? buildLoudnormFilter(measured) : null;
  if (!hasAudio) console.warn(`  [NO AUDIO] ${clipId} — додаю тишу (anullsrc)`);

  // Німа доріжка ≠ відсутня доріжка: заглушений або битий кліп має аудіо-стрім,
  // просто порожній. input_i вже виміряний для loudnorm, тож перевірка безкоштовна.
  // ffmpeg віддає "-inf" для цифрової тиші → parseFloat дає NaN.
  if (hasAudio && measured) {
    const inputI = parseFloat(measured.input_i);
    if (!isFinite(inputI) || inputI <= SILENCE_DB) {
      console.warn(`  [SILENT] ${clipId} — доріжка є, але вона німа (${measured.input_i} LUFS)`);
    }
  }

  const plan = buildPlan(inT, outT, keeps, hasAudio ? 0 : 1, audioFilter);

  console.log(`PROCESS: ${clipId} (${keeps.length} keeps, range ${fmtSec(inT)}-${fmtSec(outT)}, loudnorm=${audioFilter ? 'attenuate' : 'skip'})`);
  // clean.mp4 — завжди 30fps (вимога concat -c copy для лонгформу)
  const ok = await encodeVariant({ src, outPath, plan, hasAudio, forceFps: true, audioFilter });

  if (!ok) { console.error('FAILED:', clipId); failed++; return; }

  fs.writeFileSync(hashPath, currentHash, 'utf8');
  console.log('OK:', clipId);
  processed++;
}

async function main() {
  const clipIds = editorial.clipOrder.filter(id => !String(id).startsWith('__recon'));
  console.log(`\nProcessing ${clipIds.length} clips (concurrency: ${CONCURRENCY})\n`);

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
