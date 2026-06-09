'use strict';
// render-final.js — produce final episode from raw-episode.mp4
// Usage: node scripts/render-final.js <projectDir> <episodeNumber>

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectDir = process.argv[2];
const epNum = String(process.argv[3] || '001').padStart(3, '0');
if (!projectDir) { console.error('Usage: node render-final.js <projectDir> [episodeNumber]'); process.exit(1); }

require('./progress').step(projectDir, 11, 'Рендер лонгформ');


const base   = path.resolve(projectDir);
const input  = path.join(base, 'edit/raw-episode.mp4');
const output = path.join(base, `exports/episode-${epNum}.mp4`);

if (!fs.existsSync(input)) { console.error('Missing:', input); process.exit(1); }

console.log(`Input:  ${input}`);
console.log(`Output: ${output}`);

const args = ['-i', input, '-c', 'copy', '-movflags', '+faststart', '-y', output];

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
  const statePath = path.join(base, 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state.stages.renderLong = 'done';
      if (state.outputs) state.outputs.longformPath = output;
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch {}
  }
}
