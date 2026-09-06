#!/usr/bin/env node
// scripts/resolve-assemble.js — builds the assemble manifest from
// editorial.json + downloaded-clips.json and hands it to resolve_ctl.py,
// which does the actual Resolve API work.
// Usage: node scripts/resolve-assemble.js <runId> [--force] [--dry-run]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readJson } = require('./lib/state');
const { pythonBin } = require('./lib/sys');
const { getProjectDir } = require('./lib/project-path');
const { buildBasenameMap, processedTypeDir } = require('./lib/clip-naming');
const { getDuration } = require('./lib/media-probe');
const { buildAssembleManifest } = require('./lib/resolve-manifest');

const args = process.argv.slice(2);
const runId = args.find(a => !a.startsWith('--'));
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');

if (!runId) {
  console.error('Usage: node resolve-assemble.js <runId> [--force] [--dry-run]');
  process.exit(1);
}

const projectDir = getProjectDir(runId);
const editorial = readJson(path.join(projectDir, 'edit', 'editorial.json'));
const downloaded = readJson(path.join(projectDir, 'clips', 'downloaded-clips.json'));

const clipIds = (editorial.clipOrder || []).filter(id => !String(id).startsWith('__recon'));
const basenames = buildBasenameMap(editorial.clipOrder, downloaded);
const CLEAN_DIR = processedTypeDir(projectDir, 'clean');
const OVERLAY_DIR = processedTypeDir(projectDir, 'streamers_name');

const missing = [];
for (const clipId of clipIds) {
  const basename = basenames[clipId];
  const clipPath = path.join(CLEAN_DIR, `${basename}.mp4`);
  const overlayPath = path.join(OVERLAY_DIR, `${basename}.png`);
  if (!fs.existsSync(clipPath)) missing.push(clipPath);
  if (!fs.existsSync(overlayPath)) missing.push(overlayPath);
}

const introPath = path.resolve('assets/intro/intro_30fps.mp4');
const outroPath = path.resolve('assets/outro/outro_30fps.mp4');
if (!fs.existsSync(introPath)) missing.push(introPath);
if (!fs.existsSync(outroPath)) missing.push(outroPath);

if (missing.length > 0) {
  console.error('[FATAL] missing files, aborting before touching Resolve:');
  missing.forEach(p => console.error(`  ${p}`));
  process.exit(1);
}

const clipDurations = {};
for (const clipId of clipIds) {
  clipDurations[clipId] = getDuration(path.join(CLEAN_DIR, `${basenames[clipId]}.mp4`));
}

const manifest = buildAssembleManifest({
  runId, editorial, downloaded, clipDurations,
  projectDir: path.resolve(projectDir), introPath, outroPath,
});

const manifestPath = path.join(os.tmpdir(), `ddos-resolve-manifest-${Date.now()}.json`);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const pyArgs = ['scripts/resolve_ctl.py', 'assemble', '--manifest', manifestPath];
if (force) pyArgs.push('--force');
if (dryRun) pyArgs.push('--dry-run');

const proc = spawn(pythonBin(), pyArgs, { cwd: path.join(__dirname, '..') });
proc.stdout.on('data', d => process.stdout.write(d));
proc.stderr.on('data', d => process.stderr.write(d));
proc.on('close', (code) => {
  try { fs.unlinkSync(manifestPath); } catch {}
  process.exit(code);
});
proc.on('error', (e) => { console.error('[FATAL]', e.message); process.exit(1); });
