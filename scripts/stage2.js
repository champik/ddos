#!/usr/bin/env node
'use strict';
// stage2.js — Stage 2 orchestrator.
//
// Selection-only pipeline (final montage happens in CapCut, see
// docs/superpowers/specs/2026-08-02-capcut-handoff-design.md): a single
// serial chain after APPLY_EDITORIAL (clean.mp4 ready, FULL length — no
// trim/cuts, CapCut does the cutting):
//   fetch-avatars → render-streamer-names
// When this finishes, processed/clean/*.mp4 (full-length clips) +
// processed/streamers_name/*.png (per-streamer name-tag images) are ready
// for CapCut. TRANSCRIBE, CENSOR, and the old video-burn OVERLAYS
// (apply-overlays.js) are no longer invoked here — no transcripts means no
// censor input, and streamer identification is now a static image the user
// places by hand instead of a burned-in video overlay. CAPTIONS,
// EXTRACT_FRAMES, BUILD_CONCAT and RENDER_LONG remain unused for the same
// reason as before (their scripts still exist, just unused).
//
// METADATA no longer runs (it depended on transcripts, which no longer
// exist) — THUMBNAIL and REVIEW downstream of it are on hold too until
// that's resolved.
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

  // ── fetch-avatars → render-streamer-names (single serial chain — this is
  // now the last stage this orchestrator runs; its output (processed/clean/
  // *.mp4 + processed/streamers_name/*.png) is the CapCut handoff).
  try {
    await run('scripts/fetch-avatars.js', [projectDir]);
    await run('scripts/render-streamer-names.js', [projectDir]);
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
    console.error(`[FAIL] ${e.message}`);
    console.log(`\n=== stage2.js done in ${elapsed} min (with errors) ===\n`);
    process.exit(1);
  }

  const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n=== stage2.js done in ${elapsed} min — processed/clean/*.mp4 + processed/streamers_name/*.png ready for CapCut ===\n`);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
