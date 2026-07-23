#!/usr/bin/env node
'use strict';
const fs   = require('fs');
const path = require('path');
const { readJson } = require('./lib/state');
const { getProjectDir } = require('./lib/project-path');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node scripts/build-concat.js <runId>'); process.exit(1); }
const projectDir = path.resolve(getProjectDir(runId));
const editorial  = readJson(path.join(projectDir, 'edit/editorial.json'));

const reconnectSet  = new Set(editorial.reconnectPositions || []);
const introPath     = path.resolve('assets/intro/intro_30fps.mp4').replace(/\\/g, '/');
const outroPath     = path.resolve('assets/outro/outro_30fps.mp4').replace(/\\/g, '/');
const reconnectPath = path.resolve(projectDir, 'edit/reconnecting.mp4').replace(/\\/g, '/');

const lines = [];
lines.push("file '" + introPath + "'");

for (const clipId of editorial.clipOrder) {
  if (clipId.startsWith('__recon')) {
    if (fs.existsSync(path.resolve(projectDir, 'edit/reconnecting.mp4'))) {
      lines.push("file '" + reconnectPath + "'");
    }
    continue;
  }
  const overlayed = path.resolve(projectDir, 'processed', clipId, 'overlayed.mp4');
  const clean     = path.resolve(projectDir, 'processed', clipId, 'clean.mp4');
  const src = fs.existsSync(overlayed) ? overlayed : clean;
  if (!fs.existsSync(src)) { console.warn('MISSING:', clipId); continue; }
  lines.push("file '" + src.replace(/\\/g, '/') + "'");
  if (reconnectSet.has(clipId)) {
    lines.push("file '" + reconnectPath + "'");
  }
}

lines.push("file '" + outroPath + "'");

const outPath = path.join(projectDir, 'edit/concat-list.txt');
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log('Written: ' + outPath + ' (' + lines.length + ' entries)');
