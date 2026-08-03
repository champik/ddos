#!/usr/bin/env node
'use strict';
// vod-segment.js — replaces the raw downloaded clip (downloads/…) with the
// same [0, fullDur] span sourced from the VOD (no Twitch subtitles baked in).
//
// Runs BEFORE apply-editorial.js in stage2.js, purely as a source swap: find
// the clip inside the raw VOD via audio cross-correlation, then overwrite
// downloads/<file>.mp4 with that VOD-quality span. apply-editorial.js does
// the one and only full-length encode afterward, reading whichever source
// (original Twitch clip or VOD-replaced) is on disk by then — no separate
// clean.mp4-specific encode here anymore (that used to redo the same encode
// apply-editorial.js already did, and — because it re-applied editorial.json's
// keeps/trim while apply-editorial.js now always uses full length — could
// silently truncate a VOD-replaced clip back down to a stale keep range).
//
// Usage: node scripts/vod-segment.js <runId> <clipId1> [clipId2 ...]

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readJson } = require('./lib/state');
const { pythonBin } = require('./lib/sys');
const { getProjectDir } = require('./lib/project-path');
const { measureLoudness, buildLoudnormFilter } = require('./lib/audio-loudness');
const { getDuration, hasAudioStream, analyzeSilence, hasMuteGap } = require('./lib/media-probe');

const [,, runId, ...clipIds] = process.argv;
if (!runId || clipIds.length === 0) {
  console.error('Usage: node scripts/vod-segment.js <runId> <clipId1> [clipId2 ...]');
  process.exit(1);
}

const projectDir = getProjectDir(runId);
const downloadedPath = path.join(projectDir, 'clips', 'downloaded-clips.json');
const downloaded = readJson(downloadedPath);
const dlMap = {};
downloaded.forEach(c => { dlMap[c.id] = c; });

const TMP_ROOT = path.join(projectDir, 'clips', '_vod_tmp');

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

// Overwrites the raw downloaded clip (downloads/…) with the same [0, fullDur]
// span extracted from the VOD, so it becomes the new source of truth for
// apply-editorial.js's (single) encode pass — not just some already-encoded
// clean.mp4. rawPath is already downloaded (it covers vodClipStart±margin,
// which spans the whole clip by construction), so this reuses it instead of
// a second download. Best-effort: any failure here just leaves the raw file
// as-is and logs a warning — apply-editorial.js will simply encode the
// original Twitch clip in that case.
async function replaceRawSource(clipId, dlClip, rawPath, srcPath, fullDur, xcorrOffset, fallbackBuffer) {
  try {
    const ssOffsetFull = (xcorrOffset !== null ? xcorrOffset : fallbackBuffer);
    if (ssOffsetFull < 0) { console.warn(`  [RAW] пропущено: ssOffset<0`); return false; }

    const vodHasStream = hasAudioStream(rawPath);
    const mute = vodHasStream ? detectVodMute(rawPath, ssOffsetFull, fullDur, srcPath, 0) : { muted: false, detail: null };
    const vodAudioOk = vodHasStream && !mute.muted;
    const useOrigAudio = !vodAudioOk && fs.existsSync(srcPath) && hasAudioStream(srcPath);
    if (mute.muted && !useOrigAudio) {
      console.warn(`  [RAW] пропущено заміну сирого файлу: VOD німий і оригінал теж (${mute.detail})`);
      return false;
    }

    const audioInput = vodAudioOk ? 0 : 1;
    const fallbackInputs = vodAudioOk
      ? []
      : useOrigAudio
        ? ['-ss', '0', '-i', srcPath]
        : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'];

    const loudnessSrc = vodAudioOk ? rawPath : (useOrigAudio ? srcPath : null);
    const measured = loudnessSrc ? await measureLoudness(loudnessSrc, vodAudioOk ? { ss: ssOffsetFull, dur: fullDur } : { ss: 0, dur: fullDur }) : null;
    const loudnormFilter = loudnessSrc ? buildLoudnormFilter(measured) : null;
    const audioFilterChain = loudnormFilter ? `,${loudnormFilter}` : '';

    const tmpOut = srcPath + '.vodraw-tmp.mp4';
    const result = await ffmpegAsync([
      '-ss', ssOffsetFull.toFixed(3),
      '-i', rawPath,
      ...fallbackInputs,
      '-t', fullDur.toFixed(3),
      '-map', '0:v', '-map', `${audioInput}:a`,
      ...(!vodAudioOk && !useOrigAudio ? ['-shortest'] : []),
      '-vf', 'setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-af', `asetpts=PTS-STARTPTS${audioFilterChain}`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-r', '30',
      '-y', tmpOut
    ], 'raw-replace');

    if (!result.ok) {
      console.warn(`  [RAW] заміна сирого файлу не вдалась: ${result.stderr.slice(-150).trim()}`);
      fs.rmSync(tmpOut, { force: true });
      return false;
    }

    fs.renameSync(tmpOut, srcPath);
    dlClip.sourceReplacedWithVod = true;
    console.log(`  [RAW] downloads/${path.basename(srcPath)} замінено на VOD-версію (той самий діапазон 0-${fullDur.toFixed(1)}s)`);
    return true;
  } catch (e) {
    console.warn(`  [RAW] заміна сирого файлу впала: ${e.message}`);
    return false;
  }
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

  const srcPath = dlClip.localPath;
  const fullDur = fs.existsSync(srcPath) ? await getVideoDuration(srcPath) : (dlClip.duration || 60);

  // vod_offset = END of clip in VOD; clip starts at (vod_offset - fullDur)
  const vodClipStart = vod_offset - fullDur;

  const tmpDir = path.join(TMP_ROOT, clipId.replace(/[^a-zA-Z0-9]/g, '_'));
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
    console.warn(`  → fallback: залишаємо оригінальний завантажений файл`);
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
  if (xcorrOffset === null) console.log(`  [xcorr] fallback: ssOffset = fallbackBuffer`);

  const rawReplaced = await replaceRawSource(clipId, dlClip, rawPath, srcPath, fullDur, xcorrOffset, fallbackBuffer);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (!rawReplaced) {
    results[clipId] = { status: 'failed', streamer: dlClip.broadcaster_name, reason: 'raw source replace failed or rejected (see log above)' };
    return false;
  }

  results[clipId] = { status: 'ok', streamer: dlClip.broadcaster_name, reason: null };
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
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });

  // Персистимо sourceReplacedWithVod — без цього apply-editorial.js (читає
  // dlClip.localPath заново) не дізнається, що файл на диску вже VOD-якості
  // (хоча localPath не змінюється, тільки вміст файлу за тим самим шляхом).
  if (downloaded.some(c => c.sourceReplacedWithVod)) {
    fs.writeFileSync(downloadedPath, JSON.stringify(downloaded, null, 2));
  }

  // Persist results for resume-skill summary
  const resultsPath = path.join(projectDir, 'edit', 'vod-segment-results.json');
  fs.writeFileSync(resultsPath, JSON.stringify({ attempted: clipIds, results }, null, 2));

  const failed = clipIds.filter(id => results[id]?.status === 'failed');
  const skipped = clipIds.filter(id => results[id]?.status === 'skipped');
  console.log(`\n=== vod-segment.js done: ${ok}/${clipIds.length} replaced ===`);
  if (skipped.length > 0) {
    console.log(`Пропущено (${skipped.length}):`);
    skipped.forEach(id => console.log(`  ⚠ ${results[id].streamer || id}: ${results[id].reason}`));
  }
  if (failed.length > 0) {
    console.log(`Не вдалося (${failed.length}):`);
    failed.forEach(id => console.log(`  ✗ ${results[id].streamer || id}: ${results[id].reason}`));
  }
  console.log();
  if (ok === 0 && clipIds.length > 0) process.exit(1);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
