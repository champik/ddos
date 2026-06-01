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
const clipIds   = plan.shortClipIds || [];

// Read editorial.json for short mode / webcam coords / camPos
let editorialClips = {};
try {
  const ed = readJson(path.join(base, 'edit/editorial.json'));
  editorialClips = ed.clips || {};
} catch {}

function getShortMode(clipId) {
  return editorialClips[clipId]?.short?.mode || 'desktop';
}
function getShortWebcam(clipId) {
  return editorialClips[clipId]?.short?.webcam || null;
}
function getCamPos(clipId) {
  return editorialClips[clipId]?.short?.camPos || 'top';
}
function getCamCrop(clipId) {
  return editorialClips[clipId]?.short?.camCrop || null;
}
function getCropX(clipId) {
  // cropX: 0=full-left, 0.5=center (default), 1=full-right
  return editorialClips[clipId]?.short?.cropX ?? 0.5;
}
function getCropZoom(clipId) {
  return editorialClips[clipId]?.short?.zoom ?? 1.0;
}
function getCropAnchorY(clipId) {
  return editorialClips[clipId]?.short?.anchorY ?? 'center';
}
function getNoSubs(clipId) {
  return editorialClips[clipId]?.short?.noSubs === true;
}

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

  // Payoff-based start offset: if payoffStrength > 70, start 3s before peak
  let startOffset = 0;
  const scoreFile = path.join(base, 'processed', clipId, 'score.json');
  if (fs.existsSync(scoreFile)) {
    try {
      const score = readJson(scoreFile);
      const peak = score.peakMoment;
      if ((score.payoffStrength || 0) > 70 && peak && peak.start > 3) {
        const candidate = Math.max(0, peak.start - 3);
        // Guard: don't seek past clip duration
        const durR = spawnSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration',
          '-of', 'csv=p=0', input], { encoding: 'utf8' });
        const clipDur = parseFloat(durR.stdout) || 999;
        if (candidate < clipDur - 1) startOffset = candidate;
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

  const mode     = getShortMode(clipId);
  const webcam   = getShortWebcam(clipId);
  const camPos   = getCamPos(clipId);
  const camCrop  = getCamCrop(clipId);
  const cropX    = getCropX(clipId);
  const cropZoom = getCropZoom(clipId);
  const anchorY  = getCropAnchorY(clipId);
  const noSubs   = getNoSubs(clipId);

  const useAss = hasAss && !noSubs;
  console.log(`[SHORT:${mode.toUpperCase()}] ${clipId.slice(0, 28)}${useAss ? ' +captions' : ''}`);

  const seekArgs = startOffset > 0 ? ['-ss', startOffset.toFixed(3)] : [];
  let filterParts, ffInputs, extraArgs;

  if (mode === 'mobile') {
    // ── MOBILE: 9:16 crop; cropX: 0=left, 0.5=center, 1=right; zoom+anchorY ──
    ffInputs  = [...seekArgs, '-i', input];
    extraArgs = [];
    let cropFilter;
    if (cropZoom < 1.0) {
      // Numeric zoom crop (source assumed 1920×1080)
      const IW = 1920, IH = 1080;
      const fullW = IH * 9 / 16;
      const fullX = (IW - fullW) * cropX;
      const cW = Math.round(fullW * cropZoom);
      const cH = Math.round(IH * cropZoom);
      const cX = Math.round(fullX + (fullW - cW) / 2);
      const cY = anchorY === 'top' ? 0 : anchorY === 'bottom' ? IH - cH : Math.round((IH - cH) / 2);
      cropFilter = `crop=${cW}:${cH}:${cX}:${cY},scale=1080:1920`;
    } else {
      const cropXExpr = cropX === 0.5 ? '(iw-ih*9/16)/2' : `(iw-ih*9/16)*${cropX}`;
      cropFilter = `crop=ih*9/16:ih:${cropXExpr}:0,scale=1080:1920`;
    }
    if (useAss) {
      filterParts = [`[0:v]${cropFilter},ass=${ffmpegPath(activeAssFile)}[out]`];
    } else {
      filterParts = [`[0:v]${cropFilter}[out]`];
    }

  } else if (mode === 'split' && webcam) {
    // ── SPLIT: webcam crop (top or bottom) + scaled gameplay ──────────────────
    const [rx, ry, rw, rh] = webcam;
    const CAM_X = Math.round(rx * 1920);
    const CAM_Y = Math.round(ry * 1080);
    const CAM_W = Math.round(rw * 1920);
    const CAM_H = Math.round(rh * 1080);

    // Apply camCrop: trim top/bottom fraction then optionally squish by scale factor
    let srcCAM_Y = CAM_Y, srcCAM_H = CAM_H;
    if (camCrop) {
      const topPx = Math.round(CAM_H * (camCrop.top || 0));
      const botPx = Math.round(CAM_H * (camCrop.bottom || 0));
      srcCAM_Y = CAM_Y + topPx;
      srcCAM_H = CAM_H - topPx - botPx;
    }

    // Webcam: full 1080px wide, natural AR; squishScale shrinks output height
    let camNaturalH = Math.round(1080 * srcCAM_H / CAM_W);
    if (camCrop?.squishScale != null) camNaturalH = Math.round(camNaturalH * camCrop.squishScale);
    else if (camCrop?.squishHalf) camNaturalH = Math.round(camNaturalH / 2);
    const CAM_OUT_H  = camNaturalH % 2 === 0 ? camNaturalH : camNaturalH + 1;
    const GAME_OUT_H = 1920 - CAM_OUT_H;
    const gameOffset = (1920 - GAME_OUT_H) / 2;

    const order = camPos === 'bottom' ? '[game][cam]' : '[cam][game]';
    const fc = [
      '[0:v]split=2[vsrc1][vsrc2]',
      `[vsrc1]crop=${CAM_W}:${srcCAM_H}:${CAM_X}:${srcCAM_Y},scale=1080:${CAM_OUT_H}[cam]`,
      `[vsrc2]crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920,crop=1080:${GAME_OUT_H}:0:${gameOffset}[game]`,
      `${order}vstack=inputs=2[stacked]`
    ];

    ffInputs  = [...seekArgs, '-i', input];
    extraArgs = [];

    if (useAss) {
      fc.push(`[stacked]ass=${ffmpegPath(activeAssFile)}[out]`);
    } else {
      fc[fc.length - 1] = fc[fc.length - 1].replace('[stacked]', '[out]');
    }
    filterParts = fc;

  } else {
    // ── DESKTOP: blur background (default / fallback) ─────────────────────────
    ffInputs  = [...seekArgs, '-i', input];
    extraArgs = [];

    const blurFilters = [
      '[0:v]split[main][bg]',
      '[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5,eq=brightness=-0.3[blurred]',
      '[main]scale=1080:-2[fg]'
    ];

    if (useAss) {
      filterParts = [
        ...blurFilters,
        `[blurred][fg]overlay=(W-w)/2:(H-h)/2,ass=${ffmpegPath(activeAssFile)}[out]`
      ];
    } else {
      filterParts = [
        ...blurFilters,
        '[blurred][fg]overlay=(W-w)/2:(H-h)/2[out]'
      ];
    }
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
