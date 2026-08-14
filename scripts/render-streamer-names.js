#!/usr/bin/env node
'use strict';
// render-streamer-names.js — renders one static PNG name-tag per unique
// streamer in the episode → processed/streamers_name/<slug>.png, for manual
// placement in CapCut. Replaces the old video-burn overlay compositing
// (apply-overlays.js, no longer called from stage2.js — selection-only
// pipeline, no automated video overlay).
// Usage: node scripts/render-streamer-names.js <projectDir>

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readJson, readJsonSafe, updateState, stageStatus } = require('./lib/state');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node render-streamer-names.js <projectDir>'); process.exit(1); }

require('./progress').step(projectDir, 9, 'Картинки імені стрімера');

const plan = readJson(path.join(projectDir, 'edit/episode-plan.json'));
const downloaded = readJson(path.join(projectDir, 'clips/downloaded-clips.json'));
const { streamerDisplayName } = require('./lib/display-name');

const dlMap = {};
for (const c of downloaded) dlMap[c.id] = c;

const streamerAvatars = readJsonSafe(path.join(projectDir, 'clips/streamer-avatars.json'), {});

// Preserves the streamer's display-name casing (as shown in edit.html / on
// Twitch) in the output filename — only strips characters unsafe for a
// filename, doesn't lowercase.
function slug(name) { return name.replace(/[^a-zA-Z0-9]/g, '_'); }

const clipIds = (plan.clipOrder || []).filter(id => !String(id).startsWith('__recon'));

// One image per unique streamer, not per clip — multiple clips can share a streamer.
const byStreamer = new Map(); // slug -> { name, avatarUrl }
for (const id of clipIds) {
  const clip = dlMap[id];
  if (!clip) continue;
  const name = streamerDisplayName(clip);
  const key = slug(name);
  if (!byStreamer.has(key)) {
    byStreamer.set(key, { name, avatarUrl: streamerAvatars[clip.broadcaster_id] || null });
  }
}

const OUT_DIR = path.join(projectDir, 'processed', 'streamers_name');
fs.mkdirSync(OUT_DIR, { recursive: true });

function renderAsync(name, outPath, avatarUrl) {
  return new Promise((resolve) => {
    const args = [path.resolve('scripts/render-overlay.js'), 'streamer-static', name, outPath];
    if (avatarUrl) args.push(avatarUrl);
    const proc = spawn('node', args, { stdio: 'inherit' });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function main() {
  const entries = [...byStreamer.entries()];
  console.log(`[STREAMER_NAMES] Rendering ${entries.length} unique streamer(s)`);

  let ok = 0, failed = 0;
  for (const [key, { name, avatarUrl }] of entries) {
    const outPath = path.join(OUT_DIR, `${key}.png`);
    console.log(`  [RENDER] ${name}${avatarUrl ? ' (with avatar)' : ''}`);
    const success = await renderAsync(name, outPath, avatarUrl);
    if (success) { ok++; console.log(`  [OK] ${name} → ${outPath}`); }
    else { failed++; console.error(`  [FAIL] ${name}`); }
  }

  console.log(`\n[STREAMER_NAMES] Done: ${ok} ok, ${failed} failed`);

  updateState(projectDir, s => {
    s.stages = s.stages || {};
    s.stages.overlays = stageStatus(ok, failed);
  });

  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
