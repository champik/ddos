#!/usr/bin/env node
'use strict';
// vod-segment.js — замінює clean.mp4 на чисту версію з VOD (без субтитрів).
//
// Завантажує тільки потрібні сегменти з VOD і склеює їх в clean.mp4,
// зберігаючи ті самі trim/keeps що editorial.json задав.
//
// Usage: node scripts/vod-segment.js <runId> <clipId1> [clipId2 ...]

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readJson } = require('./lib/state');
const { pythonBin } = require('./lib/sys');
const { getProjectDir } = require('./lib/project-path');
const { measureLoudness, buildLoudnormFilter } = require('./lib/audio-loudness');
const { getDuration, hasAudioStream, analyzeSilence, hasMuteGap, isSilent } = require('./lib/media-probe');

const [,, runId, ...clipIds] = process.argv;
if (!runId || clipIds.length === 0) {
  console.error('Usage: node scripts/vod-segment.js <runId> <clipId1> [clipId2 ...]');
  process.exit(1);
}

const projectDir = getProjectDir(runId);
const editorialPath = path.join(projectDir, 'edit', 'editorial.json');
const downloadedPath = path.join(projectDir, 'clips', 'downloaded-clips.json');

const editorial = readJson(editorialPath);
const downloaded = readJson(downloadedPath);
const dlMap = {};
downloaded.forEach(c => { dlMap[c.id] = c; });

function fmtSec(sec) { return parseFloat(sec).toFixed(3); }

function ffmpegAsync(args, label) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => resolve({ ok: code === 0, stderr, label }));
    proc.on('error', e => resolve({ ok: false, stderr: e.message, label }));
  });
}

const getVideoDuration = getDuration; // lib/media-probe

// Find exact position of original clip's start within raw VOD file via audio cross-correlation.
// radius controls how far around expectedOffset to search — small for the common case
// (~1s Twitch vod_offset rounding), wide when a long stream has accumulated more VOD-timeline
// drift than that (ad breaks / reconnects not reflected 1:1 in the clip's reported offset).
// Returns ssOffset in seconds (position in raw VOD where clip begins), or null on failure.
function findExactSsOffset(origClipPath, rawVodPath, expectedOffset, radius = 5) {
  const searchStart = Math.max(0, expectedOffset - radius);
  const searchDur   = radius * 2 + 2;
  const refAudio    = rawVodPath + '_ref.raw';
  const vodAudio    = rawVodPath + '_vod.raw';

  const r1 = spawnSync('ffmpeg', [
    '-i', origClipPath, '-t', '3',
    '-vn', '-ar', '8000', '-ac', '1', '-f', 's16le', '-y', refAudio
  ], { stdio: 'pipe' });

  const r2 = spawnSync('ffmpeg', [
    '-ss', String(searchStart), '-i', rawVodPath, '-t', String(searchDur),
    '-vn', '-ar', '8000', '-ac', '1', '-f', 's16le', '-y', vodAudio
  ], { stdio: 'pipe' });

  if (r1.status !== 0 || r2.status !== 0) {
    console.warn('  [xcorr] audio extract failed');
    return null;
  }

  const pyCode = [
    'import numpy as np, sys',
    'def read(p):',
    '  with open(p,"rb") as f: return np.frombuffer(f.read(),dtype=np.int16).astype(np.float32)',
    'ref=read(sys.argv[1]); vod=read(sys.argv[2])',
    'sr=8000; ss=float(sys.argv[3])',
    'corr=np.correlate(vod,ref[:sr*3],mode="valid")',
    'pk=int(np.argmax(corr))',
    'snr=corr[pk]/max(float(np.mean(np.abs(corr))),1.0)',
    'print(f"{ss+pk/sr:.3f} {snr:.1f}")',
  ].join('\n');

  const py = spawnSync(pythonBin(), ['-c', pyCode, refAudio, vodAudio, String(searchStart)], {
    encoding: 'utf8', stdio: 'pipe'
  });

  try { fs.unlinkSync(refAudio); fs.unlinkSync(vodAudio); } catch {}

  if (py.status !== 0) { console.warn('  [xcorr] python error:', py.stderr.slice(0, 80)); return null; }

  const [offStr, snrStr] = py.stdout.trim().split(' ');
  const offset = parseFloat(offStr);
  const snr    = parseFloat(snrStr);

  if (!isFinite(offset) || snr < 5) {
    console.warn(`  [xcorr] low confidence SNR=${snr?.toFixed(1)} (±${radius}s window), falling back`);
    return null;
  }

  console.log(`  [xcorr] clip start in raw: ${offset.toFixed(3)}s (SNR ${snr.toFixed(1)}x)`);
  return offset;
}

// Чи заглушений потрібний діапазон VOD.
//
// Наявності аудіо-стріму тут недостатньо: Twitch глушить VOD за DMCA, лишаючи
// доріжку на місці — вона просто німа, і то лише на тому відрізку, де грала
// музика. Еталон для порівняння — той самий діапазон оригінального кліпу: якщо
// тиша є і там, це властивість самого моменту, а не мют VOD.
//
// → { muted: bool, detail: string|null }
function detectVodMute(rawPath, ssOffset, duration, srcPath, segStart) {
  const vod = analyzeSilence(rawPath, { ss: ssOffset, dur: duration });
  if (!vod) return { muted: false, detail: null }; // не змогли виміряти — не блокуємо

  const fullyMuted = vod.silentRatio >= 0.98;
  const partialMute = hasMuteGap(vod);
  if (!fullyMuted && !partialMute) return { muted: false, detail: null };

  const orig = fs.existsSync(srcPath)
    ? analyzeSilence(srcPath, { ss: segStart, dur: duration })
    : null;

  if (fullyMuted) {
    // Повна тиша у VOD. Якщо оригінал у тому ж місці теж німий — так і має бути.
    if (orig && orig.silentRatio >= 0.98) return { muted: false, detail: null };
    return { muted: true, detail: `VOD повністю німий (max RMS ${vod.maxRms.toFixed(1)} dB)` };
  }

  // Частковий мют — тільки якщо провал помітно довший, ніж в оригіналі.
  // Без еталона не вгадуємо: пауза в мовленні виглядає так само.
  if (!orig) return { muted: false, detail: null };
  if (vod.longestMuteSec >= orig.longestMuteSec + 1.0) {
    return {
      muted: true,
      detail: `провал тиші ${vod.longestMuteSec.toFixed(1)}s проти ${orig.longestMuteSec.toFixed(1)}s в оригіналі`,
    };
  }
  return { muted: false, detail: null };
}

// Завантажити один сегмент з VOD через yt-dlp --download-sections
function downloadVodSegment(videoId, start, end, outPath) {
  return new Promise((resolve) => {
    const vodUrl = `https://www.twitch.tv/videos/${videoId}`;
    const section = `*${fmtSec(start)}-${fmtSec(end)}`;
    const proc = spawn(pythonBin(), [
      '-m', 'yt_dlp',
      '--no-playlist',
      '--download-sections', section,
      '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--output', outPath,
      '--quiet', '--no-warnings',
      vodUrl
    ]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => resolve({ ok: code === 0 && fs.existsSync(outPath), stderr }));
    proc.on('error', e => resolve({ ok: false, stderr: e.message }));
  });
}

function extractFrameSync(input, timestamp, output) {
  const r = spawnSync('ffmpeg', [
    '-ss', String(Math.max(0, timestamp)),
    '-i', input,
    '-frames:v', '1',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    '-q:v', '3', '-update', '1', '-y', output
  ], { stdio: 'pipe' });
  return r.status === 0;
}

async function processClip(clipId, results) {
  console.log(`\n[VOD] ${clipId}`);

  const dlClip = dlMap[clipId];
  if (!dlClip) {
    console.error(`  SKIP: not in downloaded-clips`);
    results[clipId] = { status: 'skipped', streamer: null, reason: 'not in downloaded-clips' };
    return false;
  }

  const { video_id, vod_offset } = dlClip;
  if (!video_id || vod_offset == null) {
    console.warn(`  SKIP: no video_id/vod_offset — залишаємо оригінал`);
    results[clipId] = { status: 'skipped', streamer: dlClip.broadcaster_name, reason: 'no VOD metadata (video_id/vod_offset missing)' };
    return false;
  }

  const clipEdits = editorial.clips?.[clipId] || {};
  const inT = clipEdits.trim?.in ?? 0;
  const srcPath = dlClip.localPath;
  const fullDur = fs.existsSync(srcPath) ? await getVideoDuration(srcPath) : (dlClip.duration || 60);
  const outT = clipEdits.trim?.out ?? fullDur;
  const keeps = clipEdits.keeps || [];

  // vod_offset = END of clip in VOD; clip starts at (vod_offset - fullDur)
  const vodClipStart = vod_offset - fullDur;

  // Обчислити сегменти (та сама логіка що apply-editorial.js)
  const segments = keeps.length > 0
    ? keeps.map(([s, e]) => [Math.max(s, inT), Math.min(e, outT)]).filter(([s, e]) => e > s)
    : [[inT, outT]];

  const outDir = path.join(projectDir, 'processed', clipId);
  fs.mkdirSync(outDir, { recursive: true });
  const tmpDir = path.join(outDir, '_vod_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const rawPath = path.join(tmpDir, 'raw_vod.mp4');

  // Download+correlate at a given margin. Small margin covers the common ~1s
  // vod_offset rounding error cheaply; a wide margin is only paid for clips
  // where that fails — typically ones deep into a long stream, where
  // Twitch's reported vod_offset can drift tens of seconds from the true
  // VOD-timeline position (accumulated ad-break/reconnect gaps).
  async function attempt(margin, label) {
    const dlStart = Math.max(0, vodClipStart - margin);
    console.log(`  [${label}] clip in VOD: ${video_id} [${vodClipStart.toFixed(1)}s - ${vod_offset.toFixed(1)}s] (dl ${dlStart.toFixed(1)}-${(vod_offset + margin).toFixed(1)}s, ±${margin}s)`);
    const dlResult = await downloadVodSegment(video_id, dlStart, vod_offset + margin, rawPath);
    if (!dlResult.ok) return { ok: false, stderr: dlResult.stderr };
    const fallbackBuffer = vodClipStart - dlStart;
    const xcorrOffset = fs.existsSync(srcPath)
      ? findExactSsOffset(srcPath, rawPath, fallbackBuffer, margin)
      : null;
    return { ok: true, fallbackBuffer, xcorrOffset };
  }

  const NARROW_BUFFER = 3;
  const WIDE_BUFFER = 60;

  let located = await attempt(NARROW_BUFFER, 'narrow');
  if (!located.ok) {
    const errMsg = located.stderr.slice(0, 200).trim();
    console.error(`  FAIL download: ${errMsg}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.warn(`  → fallback: залишаємо оригінальний clean.mp4`);
    results[clipId] = { status: 'failed', streamer: dlClip.broadcaster_name, reason: `VOD download failed: ${errMsg || 'unknown error'}` };
    return false;
  }

  if (located.xcorrOffset === null) {
    console.log(`  [xcorr] narrow search inconclusive — retrying with wide window (±${WIDE_BUFFER}s) for long-stream drift`);
    const wide = await attempt(WIDE_BUFFER, 'wide');
    if (wide.ok) located = wide;
    else console.warn(`  [xcorr] wide retry download failed too: ${wide.stderr.slice(0, 150).trim()}`);
  }

  const { fallbackBuffer, xcorrOffset } = located;
  if (xcorrOffset === null) console.log(`  [xcorr] fallback: ssOffset = fallbackBuffer + segStart`);

  const cleanPath = path.join(outDir, 'clean.mp4');
  const cleanBak = path.join(outDir, 'clean.mp4.bak');

  // Encode кожного keep-сегмента з raw_vod.mp4 (застосовуємо editorial поверх VOD-кліпу)
  const encodedPaths = [];
  const mutedSegments = [];
  for (let i = 0; i < segments.length; i++) {
    const [segStart, segEnd] = segments[i];
    const ssOffset = xcorrOffset !== null
      ? xcorrOffset + segStart
      : fallbackBuffer + segStart;
    const duration = segEnd - segStart;
    const encodedPath = segments.length === 1 ? cleanPath : path.join(tmpDir, `enc${i}.mp4`);

    // Аудіо VOD придатне, тільки якщо доріжка є І в цьому діапазоні реально є
    // звук. Перевірка самого стріму не ловить DMCA-мют — доріжка при ньому на місці.
    const vodHasStream = hasAudioStream(rawPath);
    const mute = vodHasStream
      ? detectVodMute(rawPath, ssOffset, duration, srcPath, segStart)
      : { muted: false, detail: null };
    const vodAudioOk = vodHasStream && !mute.muted;

    if (!vodHasStream) console.warn(`  [MUTE] seg${i}: у VOD немає аудіо-доріжки`);
    else if (mute.muted) console.warn(`  [MUTE] seg${i}: ${mute.detail}`);

    // Звук з оригінального кліпу поверх VOD-картинки. Синхронність тримається
    // на тому, що ssOffset = xcorrOffset + segStart — це той самий момент.
    const useOrigAudio = !vodAudioOk && fs.existsSync(srcPath) && hasAudioStream(srcPath);
    if (mute.muted && useOrigAudio) {
      console.warn(`  [MUTE] seg${i}: беру звук з оригінального кліпу`);
      mutedSegments.push({ seg: i, detail: mute.detail, recovered: true });
    } else if (mute.muted || !vodHasStream) {
      console.warn(`  [MUTE] seg${i}: оригінал теж без звуку — сегмент лишиться німим`);
      mutedSegments.push({ seg: i, detail: mute.detail || 'no audio stream in VOD', recovered: false });
    }

    const audioInput = vodAudioOk ? 0 : 1;
    const fallbackInputs = vodAudioOk
      ? []
      : useOrigAudio
        ? ['-ss', String(segStart), '-i', srcPath]  // original clip, pre-seeked to segment start
        : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'];

    // No-boost policy: only attenuate loud audio, never boost quiet clips.
    // Міряємо саме той діапазон, що піде у відео, а не весь завантажений шматок.
    const loudnessSrc = vodAudioOk ? rawPath : (useOrigAudio ? srcPath : null);
    const loudnessRange = vodAudioOk
      ? { ss: ssOffset, dur: duration }
      : { ss: segStart, dur: duration };
    const measured = loudnessSrc ? await measureLoudness(loudnessSrc, loudnessRange) : null;
    const loudnormFilter = loudnessSrc ? buildLoudnormFilter(measured) : null;
    const audioFilterChain = loudnormFilter ? `,${loudnormFilter}` : '';

    if (i === 0 && fs.existsSync(cleanPath)) fs.renameSync(cleanPath, cleanBak);

    // Pre-seek rawPath to avoid output-level -ss applying to ALL inputs (double-seek bug
    // when fallbackInputs adds a second input with its own pre-seek).
    const result = await ffmpegAsync([
      '-ss', ssOffset.toFixed(3),
      '-i', rawPath,
      ...fallbackInputs,
      '-t', duration.toFixed(3),
      '-map', '0:v', '-map', `${audioInput}:a`,
      ...(!vodAudioOk && !useOrigAudio ? ['-shortest'] : []),
      '-vf', 'setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-af', `asetpts=PTS-STARTPTS${audioFilterChain}`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-r', '30',
      '-y', encodedPath
    ], `encode-seg${i}`);

    if (!result.ok) {
      const errMsg = result.stderr.slice(-200).trim();
      console.error(`  FAIL encode seg${i}: ${errMsg}`);
      if (fs.existsSync(cleanBak)) fs.renameSync(cleanBak, cleanPath);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      results[clipId] = { status: 'failed', streamer: dlClip.broadcaster_name, reason: `encode seg${i} failed: ${errMsg || 'unknown error'}` };
      return false;
    }
    encodedPaths.push(encodedPath);
  }

  if (segments.length > 1) {
    // Concat encoded segments → clean.mp4
    const concatList = path.resolve(tmpDir, 'concat.txt');
    fs.writeFileSync(concatList, encodedPaths.map(p => `file '${path.resolve(p).replace(/\\/g, '/')}'`).join('\n'));

    const result = await ffmpegAsync([
      '-f', 'concat', '-safe', '0', '-i', concatList,
      '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-af', 'aresample=async=1',
      '-y', cleanPath
    ], 'concat');

    if (!result.ok) {
      const errMsg = result.stderr.slice(-200).trim();
      console.error(`  FAIL concat: ${errMsg}`);
      if (fs.existsSync(cleanBak)) fs.renameSync(cleanBak, cleanPath);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      results[clipId] = { status: 'failed', streamer: dlClip.broadcaster_name, reason: `concat failed: ${errMsg || 'unknown error'}` };
      return false;
    }
  }

  // Відкат: якщо мют не вдалося перекрити звуком оригіналу, а той clean.mp4,
  // який ми щойно замінили, звук мав — VOD-версія гірша за наявну. Краще
  // лишити оригінал із субтитрами, ніж німий епізод.
  const unrecovered = mutedSegments.filter(m => !m.recovered);
  if (unrecovered.length > 0 && fs.existsSync(cleanBak)) {
    const bakSilent = isSilent(cleanBak);
    if (bakSilent === false) {
      console.warn(`  ↩ VOD-заміну скасовано: ${unrecovered.length} сегм. без звуку, а оригінал звук мав`);
      fs.rmSync(cleanPath, { force: true });
      fs.renameSync(cleanBak, cleanPath);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      results[clipId] = {
        status: 'rejected',
        streamer: dlClip.broadcaster_name,
        reason: `VOD muted: ${unrecovered.map(m => m.detail).join('; ')}`,
      };
      return false;
    }
  }

  if (fs.existsSync(cleanBak)) fs.unlinkSync(cleanBak);

  // Прибрати tmp
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Re-extract frames для оновлених кадрів
  const dur = await getVideoDuration(cleanPath);
  const framesDir = path.join(outDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const timestamps = [dur * 0.25, dur * 0.5, dur * 0.75];
  for (let i = 0; i < 3; i++) {
    extractFrameSync(cleanPath, timestamps[i], path.join(framesDir, `frame-${i + 1}.jpg`));
  }

  // Фінальна перевірка результату — VOD-заміна не повинна лишати німий кліп.
  const warnings = mutedSegments
    .filter(m => m.recovered)
    .map(m => `seg${m.seg}: ${m.detail} → звук з оригіналу`);
  if (!hasAudioStream(cleanPath)) {
    warnings.push('у готовому clean.mp4 немає аудіо-доріжки');
  } else if (isSilent(cleanPath) === true) {
    warnings.push('готовий clean.mp4 повністю німий');
  }
  warnings.forEach(w => console.warn(`  ⚠ ${w}`));

  console.log(`  ✓ clean.mp4 замінено з VOD, кадри оновлено (${dur.toFixed(1)}s)`);
  results[clipId] = {
    status: 'ok',
    streamer: dlClip.broadcaster_name,
    reason: null,
    warnings: warnings.length ? warnings : undefined,
  };
  return true;
}

async function main() {
  console.log(`\n=== vod-segment.js — ${runId} ===`);
  console.log(`Clips: ${clipIds.join(', ')}\n`);

  const results = {};
  let ok = 0;
  // Послідовно (VOD завантаження вже досить важке)
  for (const clipId of clipIds) {
    const success = await processClip(clipId, results);
    if (success) ok++;
  }

  // Persist results for resume-skill summary
  const resultsPath = path.join(projectDir, 'edit', 'vod-segment-results.json');
  fs.writeFileSync(resultsPath, JSON.stringify({ attempted: clipIds, results }, null, 2));

  const failed = clipIds.filter(id => results[id]?.status === 'failed');
  const skipped = clipIds.filter(id => results[id]?.status === 'skipped');
  const rejected = clipIds.filter(id => results[id]?.status === 'rejected');
  const warned = clipIds.filter(id => results[id]?.warnings?.length);
  console.log(`\n=== vod-segment.js done: ${ok}/${clipIds.length} replaced ===`);
  if (skipped.length > 0) {
    console.log(`Пропущено (${skipped.length}):`);
    skipped.forEach(id => console.log(`  ⚠ ${results[id].streamer || id}: ${results[id].reason}`));
  }
  if (rejected.length > 0) {
    console.log(`Скасовано через мют (${rejected.length}) — лишився оригінальний clean.mp4:`);
    rejected.forEach(id => console.log(`  ↩ ${results[id].streamer || id}: ${results[id].reason}`));
  }
  if (warned.length > 0) {
    console.log(`Зі звуковими зауваженнями (${warned.length}):`);
    warned.forEach(id => results[id].warnings.forEach(w => console.log(`  ⚠ ${results[id].streamer || id}: ${w}`)));
  }
  if (failed.length > 0) {
    console.log(`Не вдалося (${failed.length}):`);
    failed.forEach(id => console.log(`  ✗ ${results[id].streamer || id}: ${results[id].reason}`));
  }
  console.log();
  if (ok === 0 && clipIds.length > 0) process.exit(1);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
