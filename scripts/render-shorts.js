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

function shiftAssTime(t, offsetSecs) {
  const [h, m, s] = t.trim().split(':');
  let total = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s) - offsetSecs;
  if (total < 0) total = 0;
  const oh = Math.floor(total / 3600);
  const om = Math.floor((total % 3600) / 60);
  const os = (total % 60).toFixed(2).padStart(5, '0');
  return `${oh}:${String(om).padStart(2, '0')}:${os}`;
}

function shiftAss(content, offsetSecs) {
  return content.split('\n').map(line => {
    if (!line.startsWith('Dialogue:')) return line;
    const parts = line.split(',');
    if (parts.length < 3) return line;
    parts[1] = shiftAssTime(parts[1], offsetSecs);
    parts[2] = shiftAssTime(parts[2], offsetSecs);
    return parts.join(',');
  }).join('\n');
}

const base      = path.resolve(projectDir);
const plan      = readJson(path.join(base, 'edit/episode-plan.json'));
const scored    = readJson(path.join(base, 'clips/scored-clips.json'));
const clipIds   = plan.shortClipIds || [];

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

  // Payoff-based start offset: if payoffStrength > 70, start 3s before peak
  let startOffset = 0;
  const scoreFile = path.join(base, 'processed', clipId, 'score.json');
  if (fs.existsSync(scoreFile)) {
    try {
      const score = readJson(scoreFile);
      const peak = score.peakMoment;
      if ((score.payoffStrength || 0) > 70 && peak && peak.start > 3) {
        startOffset = Math.max(0, peak.start - 3);
      }
    } catch {}
  }
  if (startOffset > 0) {
    console.log(`  [PAYOFF START] offset=${startOffset.toFixed(1)}s (peak at ${(startOffset + 3).toFixed(1)}s)`);
  }

  // Write shifted ASS if needed
  let activeAssFile = assFile;
  let tmpAssPath = null;
  if (startOffset > 0 && hasAss) {
    tmpAssPath = assFile.replace('.ass', '_shifted.ass');
    fs.writeFileSync(tmpAssPath, shiftAss(fs.readFileSync(assFile, 'utf8'), startOffset), 'utf8');
    activeAssFile = tmpAssPath;
  }

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

  const seekArgs = startOffset > 0 ? ['-ss', startOffset.toFixed(3)] : [];

  if (hasHeader && hasAss) {
    filterParts = [
      ...baseFilters,
      '[base][1:v]overlay=0:0:format=auto[with_header]',
      `[with_header]ass=${ffmpegPath(activeAssFile)}[out]`
    ];
    ffInputs  = [...seekArgs, '-i', input, '-stream_loop', '-1', '-i', headerMkv];
    extraArgs = ['-shortest'];
  } else if (hasHeader) {
    filterParts = [
      ...baseFilters,
      '[base][1:v]overlay=0:0:format=auto[out]'
    ];
    ffInputs  = [...seekArgs, '-i', input, '-stream_loop', '-1', '-i', headerMkv];
    extraArgs = ['-shortest'];
  } else if (hasAss) {
    filterParts = [
      ...baseFilters.slice(0, 3),
      `[blurred][fg]overlay=(W-w)/2:(H-h)/2,ass=${ffmpegPath(activeAssFile)}[out]`
    ];
    ffInputs  = [...seekArgs, '-i', input];
    extraArgs = [];
  } else {
    filterParts = [
      ...baseFilters.slice(0, 3),
      '[blurred][fg]overlay=(W-w)/2:(H-h)/2[out]'
    ];
    ffInputs  = [...seekArgs, '-i', input];
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

  if (tmpAssPath) { try { fs.unlinkSync(tmpAssPath); } catch {} }

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
