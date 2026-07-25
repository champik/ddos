'use strict';
// audio-loudness.js — attenuate-only EBU R128 loudness policy, shared by
// apply-editorial.js and vod-segment.js. We never boost quiet clips to hit
// the -16 LUFS target — only clips louder than target get pulled down.

const { spawn } = require('child_process');

const LOUDNORM_TARGET = 'I=-16:TP=-1.5:LRA=11';

function ffmpegRun(args) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => resolve({ status: code, stderr }));
    proc.on('error', e => resolve({ status: -1, stderr: e.message }));
  });
}

// Measures integrated loudness (LUFS) without altering the file.
// ss/dur обмежують вимір діапазоном — інакше для VOD ми б міряли весь
// завантажений шматок разом із буфером ±3с (або ±60с при wide retry), а не
// той відрізок, що реально піде у відео.
//
// segments (optional): [[start,end], ...] — коли кліп має декілька keep-
// відрізків (editorial cuts), міряємо тільки те, що реально піде в конкат,
// а не проміжки, які будуть вирізані. Один відрізок — той самий швидкий
// шлях, що ss/dur; кілька — atrim+concat перед loudnorm.
async function measureLoudness(src, { ss = null, dur = null, segments = null } = {}) {
  const args = [];
  if (segments && segments.length > 1) {
    args.push('-i', src);
    const trims = segments.map(([s, e], i) => `[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
    const concatIn = segments.map((_, i) => `[a${i}]`).join('');
    const filter = `${trims.join(';')};${concatIn}concat=n=${segments.length}:v=0:a=1,loudnorm=${LOUDNORM_TARGET}:print_format=json[aout]`;
    args.push('-filter_complex', filter, '-map', '[aout]', '-f', 'null', '-');
  } else {
    const s = segments && segments.length === 1 ? segments[0][0] : ss;
    const d = segments && segments.length === 1 ? (segments[0][1] - segments[0][0]) : dur;
    if (s != null) args.push('-ss', String(s));
    args.push('-i', src);
    if (d != null) args.push('-t', String(d));
    args.push('-af', `loudnorm=${LOUDNORM_TARGET}:print_format=json`, '-f', 'null', '-');
  }
  const result = await ffmpegRun(args);
  const m = result.stderr.match(/\{[^{}]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Returns a linear (measured two-pass) loudnorm filter string when the clip
// is louder than -16 LUFS, or null (no filter — leave audio untouched) when
// it's already at or below target.
function buildLoudnormFilter(measured) {
  if (!measured) return `loudnorm=${LOUDNORM_TARGET}`; // measurement failed — fall back to single-pass
  const inputI = parseFloat(measured.input_i);
  if (!isFinite(inputI) || inputI <= -16) return null;
  return `loudnorm=${LOUDNORM_TARGET}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
}

module.exports = { LOUDNORM_TARGET, measureLoudness, buildLoudnormFilter };
