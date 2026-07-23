#!/usr/bin/env node
'use strict';
// stage2.js — Stage 2 orchestrator: runs scripts in parallel where dependencies allow.
//
// Dependency graph after APPLY_EDITORIAL (clean.mp4 ready):
//   A: TRANSCRIBE → CAPTIONS               (CPU/GPU, then CPU)
//   B: OVERLAYS → BUILD_CONCAT → RENDER_LONG  (CPU, then I/O, then I/O)
//   C: EXTRACT_FRAMES                       (CPU, fully independent)
//
// A, B, C run in parallel. METADATA and beyond (RENDER_SHORTS, THUMBNAIL, REVIEW)
// are left to Claude — they require API calls and depend on METADATA output.
//
// Usage: node scripts/stage2.js <runId> [episodeNumber]

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { getProjectDir } = require('./lib/project-path');

const runId = process.argv[2];
const epNum = String(process.argv[3] || '001').padStart(3, '0');
if (!runId) { console.error('Usage: node scripts/stage2.js <runId> [episodeNumber]'); process.exit(1); }

const projectDir = getProjectDir(runId);

function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const label = path.basename(script);
    console.log(`\n[RUN] ${label} ${args.join(' ')}`);
    const proc = spawn('node', [script, ...args], { stdio: 'inherit' });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

async function main() {
  const t0 = Date.now();
  console.log(`\n=== stage2.js — ${runId} ep=${epNum} ===\n`);

  // ── APPLY_EDITORIAL (serial — everything needs clean.mp4) ──────────────────
  await run('scripts/apply-editorial.js', [runId]);

  // ── VOD REPLACE (serial — replaces clean.mp4 for subtitle-flagged clips) ──
  const editorialPath = path.join(projectDir, 'edit', 'editorial.json');
  try {
    const editorial = JSON.parse(fs.readFileSync(editorialPath, 'utf8'));
    const vodIds = editorial.vodClipIds;
    if (Array.isArray(vodIds) && vodIds.length > 0) {
      console.log(`\n[VOD] Replacing clean.mp4 for ${vodIds.length} clip(s): ${vodIds.join(', ')}`);
      await run('scripts/vod-segment.js', [runId, ...vodIds]);
    }
  } catch {}

  // ── PARALLEL: three independent chains ────────────────────────────────────
  const chainA = run('scripts/transcribe-batch.js', [runId])
    .then(() => run('scripts/gen-captions.js', [projectDir]));

  const chainB = run('scripts/fetch-avatars.js', [projectDir])
    .then(() => run('scripts/apply-overlays.js', [projectDir]))
    .then(() => run('scripts/build-concat.js', [runId]))
    .then(() => run('scripts/render-final.js', [projectDir, epNum]));

  const chainC = run('scripts/extract-frames.js', [projectDir]);

  const results = await Promise.allSettled([chainA, chainB, chainC]);

  const labels = ['TRANSCRIBE→CAPTIONS', 'FETCH_AVATARS→OVERLAYS→RENDER_LONG', 'EXTRACT_FRAMES'];
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[FAIL] ${labels[i]}: ${r.reason.message}`);
    else console.log(`[DONE] ${labels[i]}`);
  });

  const anyFailed = results.some(r => r.status === 'rejected');
  const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n=== stage2.js done in ${elapsed} min${anyFailed ? ' (with errors)' : ''} ===\n`);

  if (anyFailed) process.exit(1);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
