'use strict';
// Robust episode concat: each segment is an FFmpeg input, then concat filter resets timestamps.
// Usage: node scripts/render-concat-filter.js <projectDir> <outputPath>

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectDir = process.argv[2];
const outputPath = process.argv[3];

if (!projectDir || !outputPath) {
  console.error('Usage: node scripts/render-concat-filter.js <projectDir> <outputPath>');
  process.exit(1);
}

const listPath = path.join(projectDir, 'edit', 'concat-list.txt');
if (!fs.existsSync(listPath)) {
  console.error('Missing:', listPath);
  process.exit(1);
}

const files = fs.readFileSync(listPath, 'utf8')
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean)
  .map(line => {
    const match = line.match(/^file '(.+)'$/);
    if (!match) throw new Error(`Bad concat-list line: ${line}`);
    return match[1];
  });

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error('Missing segment:', file);
    process.exit(1);
  }
}

const args = [];
for (const file of files) args.push('-i', file);

const filters = [];
const concatInputs = [];
for (let i = 0; i < files.length; i++) {
  filters.push(`[${i}:v]fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`);
  filters.push(`[${i}:a]aresample=48000,asetpts=PTS-STARTPTS[a${i}]`);
  concatInputs.push(`[v${i}][a${i}]`);
}
filters.push(`${concatInputs.join('')}concat=n=${files.length}:v=1:a=1[v][a]`);

args.push(
  '-filter_complex', filters.join(';'),
  '-map', '[v]',
  '-map', '[a]',
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '22',
  '-c:a', 'aac',
  '-b:a', '192k',
  '-ar', '48000',
  '-movflags', '+faststart',
  '-y', outputPath
);

console.log(`Rendering ${files.length} segments -> ${outputPath}`);
const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
