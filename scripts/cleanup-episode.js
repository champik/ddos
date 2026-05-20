#!/usr/bin/env node
// Usage: node scripts/cleanup-episode.js <runId>
// Deletes large intermediate files after episode is published.
// Keeps: clips/*.json, processed/score.json+transcript.json+hook.txt+*.ass, edit/plan+shorts+concat, exports/*, state.json, review/
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node cleanup-episode.js <runId>'); process.exit(1); }

const projectDir = path.join('projects', runId);
if (!fs.existsSync(projectDir)) { console.error(`Not found: ${projectDir}`); process.exit(1); }

function fmtMB(bytes) { return (bytes / 1024 / 1024).toFixed(0) + 'MB'; }

function deleteGlob(dir, pattern) {
  if (!fs.existsSync(dir)) return 0;
  let freed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!pattern.test(f)) continue;
    const p = path.join(dir, f);
    try {
      const size = fs.statSync(p).size;
      fs.unlinkSync(p);
      freed += size;
      console.log(`  ✓ ${path.relative(projectDir, p)} (${fmtMB(size)})`);
    } catch (e) {
      console.warn(`  ✗ ${f}: ${e.message}`);
    }
  }
  return freed;
}

function deleteFile(p) {
  if (!fs.existsSync(p)) return 0;
  const size = fs.statSync(p).size;
  fs.unlinkSync(p);
  console.log(`  ✓ ${path.relative(projectDir, p)} (${fmtMB(size)})`);
  return size;
}

let totalFreed = 0;

// 1. downloads/ — all mp4s
console.log('\n[downloads]');
totalFreed += deleteGlob(path.join(projectDir, 'downloads'), /\.mp4$/i);

// 2. processed/<clipId>/clean.mp4 and overlayed.mp4
console.log('\n[processed intermediates]');
const processedDir = path.join(projectDir, 'processed');
if (fs.existsSync(processedDir)) {
  for (const clipId of fs.readdirSync(processedDir)) {
    const clipDir = path.join(processedDir, clipId);
    if (!fs.statSync(clipDir).isDirectory()) continue;
    totalFreed += deleteFile(path.join(clipDir, 'clean.mp4'));
    totalFreed += deleteFile(path.join(clipDir, 'overlayed.mp4'));
  }
}

// 3. edit/ intermediates
console.log('\n[edit intermediates]');
const editDir = path.join(projectDir, 'edit');
totalFreed += deleteFile(path.join(editDir, 'raw-episode.mp4'));
totalFreed += deleteFile(path.join(editDir, 'reconnecting.mp4'));
totalFreed += deleteGlob(editDir, /^chill-.+\.mp4$/i);
totalFreed += deleteGlob(editDir, /^reconnecting-panel\.webm$/i);

// 4. cache/overlays — regeneratable WebMs
console.log('\n[cache]');
totalFreed += deleteGlob(path.join(projectDir, 'cache', 'overlays'), /\.webm$/i);

console.log(`\nFreed: ${fmtMB(totalFreed)} total`);
