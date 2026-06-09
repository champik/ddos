'use strict';
// apply-overlays.js — renders streamer banners + reconnecting clip using Puppeteer-rendered MKV overlays
// Animation captured frame-by-frame via render-overlay.js (FFV1+yuva420p preserves alpha on Windows)
// Usage: node scripts/apply-overlays.js <projectDir>

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node apply-overlays.js <projectDir>'); process.exit(1); }

require('./progress').step(projectDir, 10, 'Оверлеї стрімерів');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }

const plan   = readJson(path.join(projectDir, 'edit/episode-plan.json'));
const dlPath = path.join(projectDir, 'clips/downloaded-clips.json');
const downloaded = fs.existsSync(dlPath) ? readJson(dlPath) : [];

const broadcasters = {};
for (const clip of downloaded) broadcasters[clip.id] = clip.broadcaster_name;

// Cache dir for overlay MKVs — reused across episodes since design doesn't change
const CACHE_DIR = path.resolve('cache/overlays');
fs.mkdirSync(CACHE_DIR, { recursive: true });

function ffrun(args) {
  const r = spawnSync('ffmpeg', args, { stdio: 'pipe', encoding: 'utf8' });
  if (r.status !== 0) console.error('FFmpeg error:', (r.stderr || '').slice(-800));
  return r.status === 0;
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

// Ensure animated overlay MKV exists for this broadcaster (cached)
function ensureBannerMkv(broadcasterName) {
  const outPath = path.join(CACHE_DIR, `${slug(broadcasterName)}.mkv`);
  if (fs.existsSync(outPath)) {
    console.log(`  [CACHE] banner: ${broadcasterName}`);
    return outPath;
  }
  console.log(`  [RENDER] banner: ${broadcasterName} ...`);
  const r = spawnSync('node', [
    path.resolve('scripts/render-overlay.js'),
    'streamer', broadcasterName, outPath
  ], { stdio: 'inherit', encoding: 'utf8' });
  if (r.status !== 0) { console.error('render-overlay failed'); return null; }
  return outPath;
}

// Ensure reconnecting panel MKV exists (cached globally)
function ensureReconnectingMkv() {
  const outPath = path.join(CACHE_DIR, 'reconnecting-panel.mkv');
  if (fs.existsSync(outPath)) {
    console.log(`  [CACHE] reconnecting panel`);
    return outPath;
  }
  console.log(`  [RENDER] reconnecting panel ...`);
  const r = spawnSync('node', [
    path.resolve('scripts/render-overlay.js'),
    'reconnecting', outPath
  ], { stdio: 'inherit', encoding: 'utf8' });
  if (r.status !== 0) { console.error('render-overlay failed'); return null; }
  return outPath;
}

// Apply streamer banner: MKV plays once (3s animation) at clip start, then disappears
function applyStreamerOverlay(clipId, broadcasterName, skipBanner) {
  const clean = path.resolve(projectDir, 'processed', clipId, 'clean.mp4');
  const out   = path.resolve(projectDir, 'processed', clipId, 'overlayed.mp4');

  if (!fs.existsSync(clean)) { console.log(`[SKIP] No clean.mp4: ${clipId}`); return false; }

  if (skipBanner) {
    console.log(`[NO BANNER] ${broadcasterName} (consecutive)`);
    return ffrun(['-i', clean, '-c', 'copy', '-y', out]);
  }

  const bannerMkv = ensureBannerMkv(broadcasterName);
  if (!bannerMkv) {
    console.log(`[FALLBACK] ${broadcasterName} — copy without overlay`);
    return ffrun(['-i', clean, '-c', 'copy', '-y', out]);
  }

  console.log(`[OVERLAY] ${broadcasterName}`);
  const ok = ffrun([
    '-i', clean,
    '-i', bannerMkv,
    '-filter_complex', "[0:v][1:v]overlay=0:0:enable='between(t,0,3)':format=auto[out]",
    '-map', '[out]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
    '-c:a', 'copy',
    '-y', out
  ]);
  if (ok) console.log(`[OK] ${clipId}`);
  return ok;
}

// Measure average luma (Y) at a given timestamp; returns 0–255
function frameBrightness(filePath, timestamp) {
  const r = spawnSync('ffmpeg', [
    '-ss', String(timestamp), '-i', filePath,
    '-vf', 'signalstats',
    '-frames:v', '1', '-f', 'null', '-'
  ], { stdio: 'pipe', encoding: 'utf8' });
  const m = (r.stderr || '').match(/YAVG:(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// Find the first timestamp (from candidates) whose frame brightness >= minY
// Falls back to the first candidate if all are too dark
function findBrightFrame(filePath, candidates, minY = 40) {
  for (const t of candidates) {
    const y = frameBrightness(filePath, t);
    if (y >= minY) { console.log(`  [BRIGHT] t=${t}s Y=${y.toFixed(1)}`); return t; }
    console.log(`  [DARK]   t=${t}s Y=${y.toFixed(1)} (skip)`);
  }
  console.log(`  [DARK] all candidates dark — using first`);
  return candidates[0];
}

function renderReconnecting() {
  const rcId = plan.reconnectingClipId;
  if (!rcId) { console.log('[SKIP] No reconnectingClipId'); return; }

  // editorial.json can specify exact from/to for the reconnect source
  let editorialFrom = null, editorialTo = null;
  try {
    const ed = readJson(path.resolve(projectDir, 'edit/editorial.json'));
    if (ed.reconnectSource?.clipId === rcId) {
      editorialFrom = ed.reconnectSource.from ?? null;
      editorialTo   = ed.reconnectSource.to   ?? null;
    }
  } catch {}

  let peakStart = editorialFrom ?? 0;

  // Always use clean.mp4 — no streamer name banner on reconnect transition
  let src = path.resolve(projectDir, 'processed', rcId, 'clean.mp4');
  if (!fs.existsSync(src)) src = path.resolve(projectDir, 'processed', rcId, 'overlayed.mp4');

  // If editorial specifies exact from/to — use that directly, skip bright-frame scan
  let rcSs, rcDur;
  if (editorialFrom != null && editorialTo != null) {
    rcSs  = editorialFrom;
    rcDur = editorialTo - editorialFrom;
    console.log(`[RECONNECT] clipId=${rcId} editorial from=${rcSs} to=${editorialTo} dur=${rcDur.toFixed(2)}s`);
  } else {
    // Avoid dark/black frames — try peak moment and nearby timestamps
    const candidates = [peakStart, peakStart + 0.5, peakStart - 0.5, peakStart + 1.0, peakStart + 2.0]
      .filter(t => t >= 0);
    console.log(`[RECONNECT] clipId=${rcId} scanning for bright frame near t=${peakStart}s`);
    peakStart = findBrightFrame(src, candidates);
    rcSs  = Math.max(0, peakStart - 1.0);
    rcDur = 2.1;
    console.log(`[RECONNECT] clipId=${rcId} peakStart=${peakStart}`);
  }

  const out = path.resolve(projectDir, 'edit/reconnecting.mp4');

  const panelMkv = ensureReconnectingMkv();

  // B&W clip → colored panel on top → glitch (noise + hue-rotate) over everything.
  // Pipeline: [0:v] desaturate → [bw]; [bw][panel] overlay → [composite]; [composite] glitch → [out]
  const bwFilter = 'setpts=PTS-STARTPTS,eq=saturation=0:contrast=1.25:brightness=-0.05';
  const glitchFilter = "noise=alls=25:allf=t+u,hue=H='if(mod(floor(t*13),2), 1.57, 0)'";

  if (!panelMkv) {
    const ok = ffrun([
      '-ss', String(rcSs), '-t', String(rcDur), '-i', src,
      '-vf', `${bwFilter},${glitchFilter}`,
      '-t', String(rcDur),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-r', '30', '-y', out
    ]);
    if (ok) console.log(`[OK] reconnecting.mp4 (no panel)`);
    return;
  }

  const ok = ffrun([
    '-ss', String(rcSs), '-t', String(rcDur), '-i', src,
    '-i', panelMkv,
    '-filter_complex', [
      `[0:v]${bwFilter}[bw]`,
      '[bw][1:v]overlay=0:0:format=auto[composite]',
      `[composite]${glitchFilter}[out]`
    ].join(';'),
    '-map', '[out]', '-map', '0:a',
    '-t', String(rcDur),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-r', '30', '-y', out
  ]);
  if (ok) console.log(`[OK] reconnecting.mp4`);
}

// --- MAIN ---
console.log(`\n=== apply-overlays.js — ${projectDir} ===\n`);

// Build ordered clip list from groups for consecutive same-streamer detection
const orderedClips = [];
for (const group of plan.groups) {
  for (const clipId of group.clipIds) {
    orderedClips.push({ clipId, broadcaster: broadcasters[clipId] || 'Unknown' });
  }
}

const noOverlayIds = new Set(plan.noOverlayClipIds || []);

let prevBroadcaster = null;
for (const { clipId, broadcaster } of orderedClips) {
  const skipBanner = broadcaster === prevBroadcaster || noOverlayIds.has(clipId);
  applyStreamerOverlay(clipId, broadcaster, skipBanner);
  prevBroadcaster = broadcaster;
}

// Any clips in clipOrder not in groups
const groupClipIds = new Set(orderedClips.map(c => c.clipId));
for (const clipId of plan.clipOrder) {
  if (!groupClipIds.has(clipId)) {
    applyStreamerOverlay(clipId, broadcasters[clipId] || 'Unknown', false);
  }
}

renderReconnecting();
console.log('\nDone.\n');
