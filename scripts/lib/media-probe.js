'use strict';
// media-probe.js — спільні ffprobe-перевірки медіафайлів.
//
// Раніше кожен скрипт мав власну копію getDuration/hasAudioStream (apply-editorial,
// vod-segment, render-shorts, gaming-screen, extract-frames, build-metadata...).
// Тут вони зведені разом, плюс детекція РЕАЛЬНОЇ тиші — бо наявність аудіо-стріму
// нічого не гарантує: DMCA-заглушений VOD має доріжку, вона просто німа.

const { spawnSync } = require('child_process');
const { analyzeRms, WINDOW_SEC } = require('./audio-peaks');

// Поріг «доріжка є, але звуку в ній немає». Цифровий нуль ffmpeg віддає як -inf
// (analyzeRms мапить у -120); реальний фоновий шум стріму рідко тихіший за -55 dB.
const SILENCE_DB = -60;

// Мінімальна тривалість суцільної тиші, яку вважаємо збоєм. Коротші провали —
// це звичайні паузи в мовленні, їх глушити ніхто не міг.
const MIN_MUTE_RUN_SEC = 1.5;

function ffprobe(args) {
  const r = spawnSync('ffprobe', args, { encoding: 'utf8', stdio: 'pipe' });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').trim();
}

// Тривалість у секундах, або 0 якщо файл нечитабельний.
function getDuration(filePath) {
  const out = ffprobe(['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath]);
  return parseFloat(out) || 0;
}

function hasStream(filePath, kind) {
  const out = ffprobe([
    '-v', 'error', '-select_streams', kind,
    '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', filePath,
  ]);
  return !!out && out.length > 0;
}

function hasAudioStream(filePath) { return hasStream(filePath, 'a'); }
function hasVideoStream(filePath) { return hasStream(filePath, 'v'); }

// Аналіз гучності діапазону ss..ss+dur (або всього файлу).
// → { maxRms, silentRatio, longestMuteSec, windowCount } або null, якщо
// аналіз не вдався (немає ffmpeg / немає доріжки / файл занадто короткий).
// null означає «не знаю», а не «тиша» — споживачі не повинні на ньому падати.
function analyzeSilence(filePath, { ss = null, dur = null } = {}) {
  const windows = analyzeRms(filePath, { ss, dur });
  if (!windows || windows.length === 0) return null;

  let maxRms = -Infinity;
  let silentWindows = 0;
  let run = 0;
  let longestRun = 0;

  for (const w of windows) {
    if (w.rms > maxRms) maxRms = w.rms;
    if (w.rms <= SILENCE_DB) {
      silentWindows++;
      run++;
      if (run > longestRun) longestRun = run;
    } else {
      run = 0;
    }
  }

  return {
    maxRms,
    silentRatio: silentWindows / windows.length,
    longestMuteSec: longestRun * WINDOW_SEC,
    windowCount: windows.length,
  };
}

// Чи файл (або його діапазон) фактично німий — уся доріжка нижче порога.
// → true / false / null («не вдалося виміряти»).
function isSilent(filePath, opts = {}) {
  const a = analyzeSilence(filePath, opts);
  if (!a) return null;
  return a.silentRatio >= 0.98;
}

// Ознака часткового мюту: суцільний провал ≥ MIN_MUTE_RUN_SEC.
// Twitch глушить лише той відрізок VOD, де грала музика, тому інтегральної
// гучності всього файлу для детекції замало.
function hasMuteGap(analysis, minRunSec = MIN_MUTE_RUN_SEC) {
  return !!analysis && analysis.longestMuteSec >= minRunSec;
}

module.exports = {
  SILENCE_DB,
  MIN_MUTE_RUN_SEC,
  getDuration,
  hasAudioStream,
  hasVideoStream,
  analyzeSilence,
  isSilent,
  hasMuteGap,
};
