'use strict';
// render-final.js — фінальний епізод напряму з concat-list.txt (без проміжного raw-episode.mp4).
// Всі сегменти вже у єдиному форматі (H.264 30fps 1920×1080 AAC 48kHz) — тому -c copy.
// Usage: node scripts/render-final.js <projectDir> <episodeNumber>

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { updateState } = require('./lib/state');
const { getDuration, hasAudioStream, analyzeSilence } = require('./lib/media-probe');

const projectDir = process.argv[2];
const epNum = String(process.argv[3] || '001').padStart(3, '0');
if (!projectDir) { console.error('Usage: node render-final.js <projectDir> [episodeNumber]'); process.exit(1); }

require('./progress').step(projectDir, 10, 'Рендер лонгформ');

const base     = path.resolve(projectDir);
const listPath = path.join(base, 'edit/concat-list.txt');
const output   = path.join(base, `exports/episode-${epNum}.mp4`);

if (!fs.existsSync(listPath)) { console.error('Missing:', listPath); process.exit(1); }
fs.mkdirSync(path.join(base, 'exports'), { recursive: true });

// Перевірка що всі сегменти існують — зрозуміла помилка замість ffmpeg-стіни
const missing = fs.readFileSync(listPath, 'utf8')
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(Boolean)
  .map(l => (l.match(/^file '(.+)'$/) || [])[1])
  .filter(f => f && !fs.existsSync(f));
if (missing.length) {
  console.error('Missing segments:\n' + missing.join('\n'));
  process.exit(1);
}

console.log(`Input:  ${listPath}`);
console.log(`Output: ${output}`);

const r = spawnSync('ffmpeg', [
  '-f', 'concat', '-safe', '0',
  '-i', listPath,
  '-c', 'copy', '-movflags', '+faststart',
  '-y', output
], { stdio: 'pipe', encoding: 'utf8' });

console.log('EXIT:', r.status);
if (r.status !== 0) {
  const lines = (r.stderr || '').split('\n');
  const errors = lines.filter(l => /error/i.test(l));
  if (errors.length) console.log('Errors:\n' + errors.join('\n'));
  else console.log('Last stderr:\n' + lines.slice(-15).join('\n'));
  updateState(base, s => { s.stages = s.stages || {}; s.stages.renderLong = 'failed'; });
  process.exit(1);
} else {
  // Перевірка результату, а не лише коду виходу: concat -c copy може віддати
  // епізод без звуку і при цьому завершитись успішно.
  const problems = [];
  const dur = getDuration(output);
  if (dur <= 0) problems.push('не читається тривалість');
  if (!hasAudioStream(output)) {
    problems.push('в епізоді немає аудіо-доріжки');
  } else {
    const sil = analyzeSilence(output);
    if (sil && sil.silentRatio >= 0.98) {
      problems.push(`епізод повністю німий (max RMS ${sil.maxRms.toFixed(1)} dB)`);
    } else if (sil && sil.longestMuteSec >= 5) {
      problems.push(`${sil.longestMuteSec.toFixed(1)}s суцільної тиші в епізоді`);
    }
  }

  if (problems.length > 0) {
    console.error('[AUDIO] ' + problems.join('; '));
    updateState(base, s => {
      s.stages = s.stages || {};
      s.stages.renderLong = 'done_with_errors';
      s.outputs = s.outputs || {};
      s.outputs.longformPath = output;
      s.warnings = s.warnings || [];
      s.warnings.push(...problems.map(p => `renderLong: ${p}`));
    });
    process.exit(1);
  }

  console.log('[OK]', output, `(${dur.toFixed(1)}s)`);
  updateState(base, s => {
    s.stages = s.stages || {};
    s.stages.renderLong = 'done';
    s.outputs = s.outputs || {};
    s.outputs.longformPath = output;
  });
}
