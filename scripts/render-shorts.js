'use strict';
// render-shorts.js — 1080x1920 shorts: blur bg + pulsating logo/nick (MKV overlay) + bottom captions
// Header MKV loops seamlessly via -stream_loop -1; video fg is centered in full frame.
// Uses clean.mp4 (no streamer banner — nick is already in header overlay).
// Usage: node scripts/render-shorts.js <projectDir>

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node render-shorts.js <projectDir>'); process.exit(1); }

require('./progress').step(projectDir, 12, 'Рендер шортсів');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }

function ffmpegPath(p) {
  const m = p.match(/^([A-Za-z]):(.*)/);
  if (!m) return p.replace(/\\/g, '/');
  return m[1] + '\\\\:' + m[2].replace(/\\/g, '/');
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

const base      = path.resolve(projectDir);
const selection = readJson(path.join(base, 'edit/shorts-selection.json'));
const scored    = readJson(path.join(base, 'clips/scored-clips.json'));
const clipIds   = selection.shortClipIds || [];

const broadcasters = {};
for (const clip of scored) broadcasters[clip.id] = clip.broadcaster_name;

const CACHE_DIR = path.resolve('cache/overlays');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const outDir = path.join(base, 'exports/shorts');
fs.mkdirSync(outDir, { recursive: true });

function ensureHeaderMkv(broadcasterName) {
  const outPath = path.join(CACHE_DIR, `header_${slug(broadcasterName)}.mkv`);
  if (fs.existsSync(outPath)) {
    console.log(`  [CACHE] header: @${broadcasterName}`);
    return outPath;
  }
  console.log(`  [RENDER] header: @${broadcasterName} ...`);
  const r = spawnSync('node', [
    path.resolve('scripts/render-overlay.js'),
    'shorts-header', broadcasterName, outPath
  ], { stdio: 'inherit', encoding: 'utf8' });
  if (r.status !== 0) { console.error('render-overlay shorts-header failed'); return null; }
  return outPath;
}

console.log(`\n=== render-shorts.js — ${projectDir} ===`);
console.log(`Rendering ${clipIds.length} shorts\n`);

let ok = 0, fail = 0;

for (const clipId of clipIds) {
  // Use clean.mp4 — no streamer banner (header overlay shows nick already)
  const input      = path.join(base, 'processed', clipId, 'clean.mp4');
  const assFile    = path.join(base, 'processed', clipId, 'captions-vertical.ass');
  const output     = path.join(outDir, `${clipId}.mp4`);
  const broadcaster = broadcasters[clipId] || 'Unknown';

  if (!fs.existsSync(input)) {
    console.log(`[SKIP] No clean.mp4: ${clipId}`);
    fail++;
    continue;
  }

  const hasAss    = fs.existsSync(assFile);
  const headerMkv = ensureHeaderMkv(broadcaster);
  const hasHeader = !!headerMkv && fs.existsSync(headerMkv);

  console.log(`[SHORT] @${broadcaster} — ${clipId.slice(0, 28)}${hasAss ? ' +captions' : ''}`);

  // Layout:
  //   [bg]  — blurred, fills 1080×1920
  //   [fg]  — 1080×1080, centered vertically at (H-h)/2 = y≈420
  //   [header MKV] — 1080×1920 transparent; logo+nick pulse at y≈178, overlaid on top
  //   [captions]   — ASS burned at bottom (MarginV=340)
  //
  // The header MKV is full-frame but transparent below the logo/nick area,
  // so it doesn't occlude the video content below y≈250.

  const baseFilters = [
    '[0:v]split[main][bg]',
    '[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5,eq=brightness=-0.3[blurred]',
    // scale to 1080px wide, natural height from aspect ratio (no padding = no black bars)
    '[main]scale=1080:-2[fg]',
    '[blurred][fg]overlay=(W-w)/2:(H-h)/2[base]'
  ];

  let filterParts, ffInputs, extraArgs;

  if (hasHeader && hasAss) {
    filterParts = [
      ...baseFilters,
      '[base][1:v]overlay=0:0:format=auto[with_header]',
      `[with_header]ass=${ffmpegPath(assFile)}[out]`
    ];
    ffInputs  = ['-i', input, '-stream_loop', '-1', '-i', headerMkv];
    extraArgs = ['-shortest'];
  } else if (hasHeader) {
    filterParts = [
      ...baseFilters,
      '[base][1:v]overlay=0:0:format=auto[out]'
    ];
    ffInputs  = ['-i', input, '-stream_loop', '-1', '-i', headerMkv];
    extraArgs = ['-shortest'];
  } else if (hasAss) {
    filterParts = [
      ...baseFilters.slice(0, 3),
      `[blurred][fg]overlay=(W-w)/2:(H-h)/2,ass=${ffmpegPath(assFile)}[out]`
    ];
    ffInputs  = ['-i', input];
    extraArgs = [];
  } else {
    filterParts = [
      ...baseFilters.slice(0, 3),
      '[blurred][fg]overlay=(W-w)/2:(H-h)/2[out]'
    ];
    ffInputs  = ['-i', input];
    extraArgs = [];
  }

  const r = spawnSync('ffmpeg', [
    ...ffInputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[out]',
    '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '24',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-movflags', '+faststart',
    ...extraArgs,
    '-y', output
  ], { stdio: 'pipe', encoding: 'utf8' });

  if (r.status === 0) {
    console.log(`[OK] ${clipId.slice(0, 32)}`);
    ok++;
  } else {
    const lines = (r.stderr || '').split('\n');
    const errLines = lines.filter(l => /error/i.test(l));
    console.error(`[FAIL] ${clipId}`);
    console.error((errLines.length ? errLines.slice(0, 3) : lines.slice(-5)).join('\n'));
    fail++;
  }
}

console.log(`\nDone. ${ok} ok, ${fail} failed.\n`);
