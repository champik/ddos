#!/usr/bin/env node
'use strict';
// render-streamer-names.js — renders one static PNG name-tag per CLIP (basename
// matches processed/clean/<basename>.mp4 exactly, via lib/clip-naming.js) →
// processed/streamers_name/<basename>.png, for manual placement in CapCut.
// One file per clip (not deduped by streamer) because the tag now carries
// per-clip data (view count, date, and — for ranking-style episodes like
// TopClips — a "#N" rank within its category) that differs clip to clip even
// for the same streamer. Replaces the old video-burn overlay compositing
// (apply-overlays.js, no longer called from stage2.js — selection-only
// pipeline, no automated video overlay).
// Usage: node scripts/render-streamer-names.js <projectDir>

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readJson, readJsonSafe, updateState, stageStatus } = require('./lib/state');
const { buildBasenameMap } = require('./lib/clip-naming');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node render-streamer-names.js <projectDir>'); process.exit(1); }

require('./progress').step(projectDir, 9, 'Картинки імені стрімера');

const plan = readJson(path.join(projectDir, 'edit/episode-plan.json'));
const downloaded = readJson(path.join(projectDir, 'clips/downloaded-clips.json'));
const { streamerDisplayName } = require('./lib/display-name');

const dlMap = {};
for (const c of downloaded) dlMap[c.id] = c;

const streamerAvatars = readJsonSafe(path.join(projectDir, 'clips/streamer-avatars.json'), {});

const clipIds = (plan.clipOrder || []).filter(id => !String(id).startsWith('__recon'));
const basenames = buildBasenameMap(plan.clipOrder, downloaded);

// Ranking-style episode (e.g. TopClips): state carries either flag when the
// video plays each category's clips low→high views. Regular episodes have no
// "#N" concept, so the rank badge stays off (renderAsync passes no rank).
const state = readJsonSafe(path.join(projectDir, 'state.json'), {});
const RANKING_MODE = state.viewOrderAscending === true || (state.categoryOrder || []).length > 0;

// Rank = clip's 1-based popularity position within its own category — #1 is
// always the most-viewed clip in that category, #N the least, regardless of
// which order they actually play in (the video plays low→high views, ending
// on the #1 clip; the badge always reads "how good is this clip", not "what
// position does it play at").
const rankByClipId = {};
if (RANKING_MODE) {
  const byCategory = new Map();
  for (const id of clipIds) {
    const c = dlMap[id];
    if (!c) continue;
    const key = c.game_name || '';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(c);
  }
  for (const clips of byCategory.values()) {
    clips.sort((a, b) => b.view_count - a.view_count);
    clips.forEach((c, i) => { rankByClipId[c.id] = i + 1; });
  }
}

function formatViews(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return String(n);
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const OUT_DIR = path.join(projectDir, 'processed', 'streamers_name');
fs.mkdirSync(OUT_DIR, { recursive: true });

function renderAsync(name, outPath, avatarUrl, meta) {
  return new Promise((resolve) => {
    const args = [path.resolve('scripts/render-overlay.js'), 'streamer-static', name, outPath];
    args.push(avatarUrl || '');
    args.push(JSON.stringify(meta));
    const proc = spawn('node', args, { stdio: 'inherit' });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function main() {
  console.log(`[STREAMER_NAMES] Rendering ${clipIds.length} clip tag(s)${RANKING_MODE ? ' (ranking mode: rank badge on)' : ''}`);

  let ok = 0, failed = 0;
  for (const clipId of clipIds) {
    const clip = dlMap[clipId];
    if (!clip) { console.warn(`  [WARN] clip ${clipId} not found in downloaded-clips.json, skipping`); continue; }
    const name = streamerDisplayName(clip);
    const basename = basenames[clipId];
    const outPath = path.join(OUT_DIR, `${basename}.png`);
    const avatarUrl = streamerAvatars[clip.broadcaster_id] || null;
    // Default (regular episode) = plain classic tag, name + avatar only.
    // Ranking-style episodes (TopClips) turn on views/date + "#N" rank.
    const meta = RANKING_MODE ? {
      views: formatViews(clip.view_count),
      date: formatDate(clip.broadcastedAt || clip.created_at),
      rank: rankByClipId[clipId],
    } : {};
    console.log(`  [RENDER] ${basename} — ${name}${avatarUrl ? ' (with avatar)' : ''}${meta.rank ? ` #${meta.rank}` : ''}`);
    const success = await renderAsync(name, outPath, avatarUrl, meta);
    if (success) { ok++; console.log(`  [OK] ${basename} → ${outPath}`); }
    else { failed++; console.error(`  [FAIL] ${basename}`); }
  }

  console.log(`\n[STREAMER_NAMES] Done: ${ok} ok, ${failed} failed`);

  updateState(projectDir, s => {
    s.stages = s.stages || {};
    s.stages.overlays = stageStatus(ok, failed);
  });

  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
