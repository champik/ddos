#!/usr/bin/env node
'use strict';
// stage2.js — Stage 2 orchestrator.
//
// Selection-only pipeline (final montage happens in CapCut, see
// docs/superpowers/specs/2026-08-02-capcut-handoff-design.md): a single
// serial chain:
//   VOD_REPLACE (raw source swap) → APPLY_EDITORIAL (the one full-length
//   encode) → fetch-avatars → render-streamer-names
// VOD_REPLACE runs FIRST and only swaps downloads/<file>.mp4 for a
// VOD-quality span — it does not encode processed/clean/ itself anymore.
// That way each clip gets encoded exactly once, by apply-editorial.js,
// reading whichever source (original Twitch clip or VOD-replaced) ended up
// on disk. The old order (encode, then have vod-segment.js re-encode
// clean.mp4 again for VOD clips) did the same encode twice for every VOD
// clip, and vod-segment.js's second pass re-applied editorial.json's
// keeps/trim — which apply-editorial.js otherwise ignores — so it could
// silently truncate a VOD-replaced clip back down to a stale keep range.
//
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
// exist) — REVIEW downstream of it is on hold too until that's resolved.
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

  // ── VOD REPLACE (serial — swaps downloads/<file>.mp4 for subtitle-flagged
  // clips BEFORE anything gets encoded, so apply-editorial.js encodes each
  // clip's final source exactly once) ──────────────────────────────────────
  const editorialPath = path.join(projectDir, 'edit', 'editorial.json');
  try {
    const editorial = JSON.parse(fs.readFileSync(editorialPath, 'utf8'));
    const vodIds = editorial.vodClipIds;
    if (Array.isArray(vodIds) && vodIds.length > 0) {
      console.log(`\n[VOD] Replacing raw source for ${vodIds.length} clip(s): ${vodIds.join(', ')}`);
      await run('scripts/vod-segment.js', [runId, ...vodIds]);
    }
  } catch {}

  // ── APPLY_EDITORIAL (serial — the one full-length encode pass) ─────────────
  await run('scripts/apply-editorial.js', [runId]);

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
