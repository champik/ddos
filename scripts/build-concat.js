'use strict';
const fs = require('fs');
const path = require('path');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node build-concat.js <projectDir>'); process.exit(1); }

const plan = JSON.parse(fs.readFileSync(path.join(projectDir, 'edit/episode-plan.json'), 'utf8'));
const base = path.resolve(projectDir);

const lines = [];
function add(p) {
  const full = path.resolve(p).replace(/\\/g, '/');
  if (!fs.existsSync(full)) { console.warn('MISSING:', full); return; }
  lines.push("file '" + full + "'");
}

add('assets/intro/intro_30fps.mp4');

const groups = plan.groups;
for (let gi = 0; gi < groups.length; gi++) {
  const g = groups[gi];
  for (const clipId of g.clipIds) {
    const ov = path.join(base, 'processed', clipId, 'overlayed.mp4');
    const cl = path.join(base, 'processed', clipId, 'clean.mp4');
    add(fs.existsSync(ov) ? ov : cl);
  }
  const isLast = gi === groups.length - 1;
  const isFirst = gi === 0;
  if (!isLast && !isFirst) {
    add(path.join(projectDir, 'edit/reconnecting.mp4'));
  }
}

add(path.join(projectDir, 'edit/chill-finale.mp4'));
add('assets/outro/outro_30fps.mp4');

const outPath = path.join(projectDir, 'edit/concat-list.txt');
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log('Written ' + outPath + ' — ' + lines.length + ' entries');
lines.forEach(l => console.log(l));
