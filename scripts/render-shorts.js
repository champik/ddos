'use strict';
// render-shorts.js — 1080x1920 shorts: blur bg + bottom captions
// Uses clean.mp4 (no streamer banner).
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


const base      = path.resolve(projectDir);
const plan      = readJson(path.join(base, 'edit/episode-plan.json'));
const clipIds   = plan.shortClipIds || [];

// Read editorial.json for short crop data
let editorialClips = {};
try {
  const ed = readJson(path.join(base, 'edit/editorial.json'));
  editorialClips = ed.clips || {};
} catch {}

// % of source frame → pixels (assumes 1920×1080 source)
function px(pct, axis) { return Math.round(pct / 100 * (axis === 'w' ? 1920 : 1080)); }
function even(n) { return n % 2 === 0 ? n : n + 1; }

function getShort(clipId) { return editorialClips[clipId]?.short || null; }
function getNoSubs(clipId) { return editorialClips[clipId]?.short?.noSubs === true; }

const outDir = path.join(base, 'exports/shorts');
fs.mkdirSync(outDir, { recursive: true });

console.log(`\n=== render-shorts.js — ${projectDir} ===`);
console.log(`Rendering ${clipIds.length} shorts\n`);

let ok = 0, fail = 0;

for (const clipId of clipIds) {
  const input   = path.join(base, 'processed', clipId, 'clean.mp4');
  const assFile = path.join(base, 'processed', clipId, 'captions-vertical.ass');
  const output  = path.join(outDir, `${clipId}.mp4`);

  if (!fs.existsSync(input)) {
    console.log(`[SKIP] No clean.mp4: ${clipId}`);
    fail++;
    continue;
  }

  const hasAss = fs.existsSync(assFile);

  const short  = getShort(clipId);
  const mode   = short?.mode || 'desktop';
  const noSubs = getNoSubs(clipId);
  const useAss = hasAss && !noSubs;
  console.log(`[SHORT:${mode.toUpperCase()}] ${clipId.slice(0, 28)}${useAss ? ' +captions' : ''}`);

  let filterParts, ffInputs = ['-i', input];

  if (mode === 'mobile') {
    // ── MOBILE: crop selected 9:16 region ────────────────────────────────────
    const c = short?.mobile || { x: 34.18, y: 0, w: 31.64, h: 100 };
    const cw = px(c.w, 'w'), ch = px(c.h, 'h'), cx = px(c.x, 'w'), cy = px(c.y, 'h');
    const cropFilter = `crop=${cw}:${ch}:${cx}:${cy},scale=1080:1920`;
    filterParts = useAss
      ? [`[0:v]${cropFilter},ass=${ffmpegPath(assFile)}[out]`]
      : [`[0:v]${cropFilter}[out]`];

  } else if (mode === 'split' && short?.split) {
    // ── SPLIT: webcam top + gameplay bottom ───────────────────────────────────
    const sp = short.split;
    const ratio   = sp.ratio ?? 0.7;
    const GAME_H  = even(Math.round(1920 * ratio));
    const CAM_H   = 1920 - GAME_H;

    const g  = sp.gameplay || { x: 0, y: 0, w: 100, h: 100 };
    const wc = sp.webcam   || { x: 2,  y: 2, w: 30,  h: 30  };
    const GW = px(g.w,'w'), GH = px(g.h,'h'), GX = px(g.x,'w'), GY = px(g.y,'h');
    const WW = px(wc.w,'w'), WH = px(wc.h,'h'), WX = px(wc.x,'w'), WY = px(wc.y,'h');

    const fc = [
      '[0:v]split=2[vsrc1][vsrc2]',
      `[vsrc1]crop=${WW}:${WH}:${WX}:${WY},scale=1080:${CAM_H}[cam]`,
      `[vsrc2]crop=${GW}:${GH}:${GX}:${GY},scale=1080:${GAME_H}[game]`,
      '[cam][game]vstack=inputs=2[stacked]'
    ];
    if (useAss) fc.push(`[stacked]ass=${ffmpegPath(assFile)}[out]`);
    else fc[fc.length - 1] = fc[fc.length - 1].replace('[stacked]', '[out]');
    filterParts = fc;

  } else {
    // ── DESKTOP: crop selected 16:9 region + blur background ─────────────────
    const c = short?.desktop || { x: 0, y: 0, w: 100, h: 100 };
    const cropStep = c.w >= 99 ? '' :
      `crop=${px(c.w,'w')}:${px(c.h,'h')}:${px(c.x,'w')}:${px(c.y,'h')},`;

    const blurFilters = [
      `[0:v]${cropStep}split[main][bg]`,
      '[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5,eq=brightness=-0.3[blurred]',
      '[main]scale=1080:-2[fg]'
    ];
    filterParts = useAss
      ? [...blurFilters, `[blurred][fg]overlay=(W-w)/2:(H-h)/2,ass=${ffmpegPath(assFile)}[out]`]
      : [...blurFilters, '[blurred][fg]overlay=(W-w)/2:(H-h)/2[out]'];
  }

  // Ensure SAR=1:1 so players don't add black bars from incorrect pixel AR
  filterParts[filterParts.length - 1] = filterParts[filterParts.length - 1].replace(/\[out\]$/, '[out_sar]');
  filterParts.push('[out_sar]setsar=1[out]');

  const r = spawnSync('ffmpeg', [
    ...ffInputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[out]',
    '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
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

const statePath = path.join(base, 'state.json');
if (fs.existsSync(statePath)) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.stages.renderShorts = 'done';
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {}
}
