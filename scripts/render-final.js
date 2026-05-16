'use strict';
// render-final.js — burn captions and produce final episode
// Usage: node scripts/render-final.js <projectDir> <episodeNumber>

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectDir = process.argv[2];
const epNum = String(process.argv[3] || '001').padStart(3, '0');
if (!projectDir) { console.error('Usage: node render-final.js <projectDir> [episodeNumber]'); process.exit(1); }

require('./progress').step(projectDir, 11, 'Рендер лонгформ');

function ffmpegPath(p) {
  const m = p.match(/^([A-Za-z]):(.*)/);
  if (!m) return p.replace(/\\/g, '/');
  return m[1] + '\\\\:' + m[2].replace(/\\/g, '/');
}

const base   = path.resolve(projectDir);
const input  = path.join(base, 'edit/raw-episode.mp4');
const assFile = path.join(base, 'edit/episode.ass');
const output = path.join(base, `exports/episode-${epNum}.mp4`);

if (!fs.existsSync(input)) { console.error('Missing:', input); process.exit(1); }

const hasAss = fs.existsSync(assFile);
console.log(`Input:  ${input}`);
console.log(`ASS:    ${hasAss ? assFile : '(none)'}`);
console.log(`Output: ${output}`);

let args;
if (hasAss) {
  const assPath = ffmpegPath(assFile);
  args = [
    '-i', input,
    '-vf', `ass=${assPath}`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '22',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-y', output
  ];
} else {
  args = ['-i', input, '-c', 'copy', '-movflags', '+faststart', '-y', output];
}

console.log('\nRendering...');
const r = spawnSync('ffmpeg', args, { stdio: 'pipe', encoding: 'utf8' });

console.log('EXIT:', r.status);
if (r.status !== 0) {
  const lines = (r.stderr || '').split('\n');
  const errors = lines.filter(l => /error/i.test(l));
  if (errors.length) console.log('Errors:\n' + errors.join('\n'));
  else console.log('Last stderr:\n' + lines.slice(-15).join('\n'));
} else {
  console.log('[OK]', output);
}
