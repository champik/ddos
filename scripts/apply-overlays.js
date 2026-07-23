'use strict';
// apply-overlays.js — renders streamer banners + reconnecting clip using Puppeteer-rendered MKV overlays
// Two-pass: (1) pre-render all missing banner MKVs in parallel, (2) apply FFmpeg overlays in parallel.
// Usage: node scripts/apply-overlays.js <projectDir>

const fs   = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readJson, readJsonSafe, updateState, stageStatus } = require('./lib/state');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node apply-overlays.js <projectDir>'); process.exit(1); }

require('./progress').step(projectDir, 9, 'Оверлеї стрімерів');

const plan   = readJson(path.join(projectDir, 'edit/episode-plan.json'));
const dlPath = path.join(projectDir, 'clips/downloaded-clips.json');
const downloaded = fs.existsSync(dlPath) ? readJson(dlPath) : [];

const { streamerDisplayName } = require('./lib/display-name');
const broadcasters = {};
for (const clip of downloaded) broadcasters[clip.id] = streamerDisplayName(clip);

const streamerAvatars = readJsonSafe(path.join(projectDir, 'clips/streamer-avatars.json'), {});
const avatarByDisplayName = {};
for (const clip of downloaded) {
  const url = streamerAvatars[clip.broadcaster_id];
  if (url) avatarByDisplayName[streamerDisplayName(clip)] = url;
}

const CACHE_DIR = path.resolve('cache/overlays');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const PUPPETEER_CONCURRENCY = 2; // Puppeteer launches are memory-heavy
const FFMPEG_CONCURRENCY    = 4; // FFmpeg overlay applications

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function ffrunAsync(args) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) console.error('FFmpeg error:', stderr.slice(-800));
      resolve(code === 0);
    });
    proc.on('error', () => resolve(false));
  });
}

function renderBannerAsync(broadcasterName, outPath, avatarUrl) {
  return new Promise((resolve) => {
    console.log(`  [RENDER] banner: ${broadcasterName}${avatarUrl ? ' (with avatar)' : ''}`);
    const spawnArgs = [path.resolve('scripts/render-overlay.js'), 'streamer', broadcasterName, outPath];
    if (avatarUrl) spawnArgs.push(avatarUrl);
    const proc = spawn('node', spawnArgs, { stdio: 'inherit' });
    proc.on('close', code => {
      if (code !== 0) console.error(`  [FAIL] banner render: ${broadcasterName}`);
      resolve(code === 0);
    });
    proc.on('error', () => resolve(false));
  });
}

async function applyStreamerOverlay(clipId, broadcasterName, skipBanner) {
  const clean = path.resolve(projectDir, 'processed', clipId, 'clean.mp4');
  const out   = path.resolve(projectDir, 'processed', clipId, 'overlayed.mp4');

  if (!fs.existsSync(clean)) { console.log(`[SKIP] No clean.mp4: ${clipId}`); return false; }

  if (skipBanner) {
    console.log(`[NO BANNER] ${broadcasterName} (consecutive)`);
    return ffrunAsync(['-i', clean, '-c', 'copy', '-y', out]);
  }

  const bannerMkv = path.join(CACHE_DIR, `${slug(broadcasterName)}.mkv`);
  if (!fs.existsSync(bannerMkv)) {
    console.log(`[FALLBACK] ${broadcasterName} — copy without overlay`);
    return ffrunAsync(['-i', clean, '-c', 'copy', '-y', out]);
  }

  console.log(`[OVERLAY] ${broadcasterName}`);
  // CRF 18: overlayed.mp4 потрапляє у фінальний епізод через concat -c copy
  const ok = await ffrunAsync([
    '-i', clean,
    '-i', bannerMkv,
    '-filter_complex', "[0:v][1:v]overlay=0:0:enable='between(t,0,5)':format=auto[out]",
    '-map', '[out]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'copy',
    '-y', out
  ]);
  if (ok) console.log(`[OK] ${clipId}`);
  return ok;
}

function frameBrightness(filePath, timestamp) {
  const r = spawnSync('ffmpeg', [
    '-ss', String(timestamp), '-i', filePath,
    '-vf', 'signalstats',
    '-frames:v', '1', '-f', 'null', '-'
  ], { stdio: 'pipe', encoding: 'utf8' });
  const m = (r.stderr || '').match(/YAVG:(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

function findBrightFrame(filePath, candidates, minY = 40) {
  for (const t of candidates) {
    const y = frameBrightness(filePath, t);
    if (y >= minY) { console.log(`  [BRIGHT] t=${t}s Y=${y.toFixed(1)}`); return t; }
    console.log(`  [DARK]   t=${t}s Y=${y.toFixed(1)} (skip)`);
  }
  console.log(`  [DARK] all candidates dark — using first`);
  return candidates[0];
}

async function renderReconnecting() {
  const rcId = plan.reconnectingClipId;
  if (!rcId) { console.log('[SKIP] No reconnectingClipId'); return; }

  let editorialFrom = null, editorialTo = null;
  try {
    const ed = readJson(path.resolve(projectDir, 'edit/editorial.json'));
    if (ed.reconnectSource?.clipId === rcId) {
      editorialFrom = ed.reconnectSource.from ?? null;
      editorialTo   = ed.reconnectSource.to   ?? null;
    }
  } catch {}

  let peakStart = editorialFrom ?? 0;

  // Завжди береться clean.mp4 (VOD-замінений якщо є), а не оригінальний завантажений файл.
  // Таймстамп коригується на початок першого keep-сегменту.
  let src = path.resolve(projectDir, 'processed', rcId, 'clean.mp4');
  if (!fs.existsSync(src)) src = path.resolve(projectDir, 'processed', rcId, 'overlayed.mp4');

  let rcSs, rcDur;
  if (editorialFrom != null && editorialTo != null) {
    // Map original-clip timestamp → clean.mp4 timestamp, accounting for all keep segments.
    // If keeps are defined, accumulate duration of preceding segments to find position in clean.mp4.
    let mappedFrom = editorialFrom;
    try {
      const ed2 = readJson(path.resolve(projectDir, 'edit/editorial.json'));
      const keeps = ed2.clips?.[rcId]?.keeps;
      if (keeps && keeps.length > 0) {
        let accumulated = 0;
        let found = false;
        for (const [s, e] of keeps) {
          if (editorialFrom >= s && editorialFrom <= e) {
            mappedFrom = accumulated + (editorialFrom - s);
            found = true;
            break;
          }
          accumulated += (e - s);
        }
        if (!found) mappedFrom = accumulated; // fallback: end of last segment
      }
    } catch {}
    rcSs  = Math.max(0, mappedFrom);
    rcDur = editorialTo - editorialFrom;
    console.log(`[RECONNECT] clipId=${rcId} editorial from=${editorialFrom} to=${editorialTo} mappedFrom=${mappedFrom.toFixed(3)} → ss=${rcSs.toFixed(3)} dur=${rcDur.toFixed(2)}s`);
  } else {
    const candidates = [peakStart, peakStart + 0.5, peakStart - 0.5, peakStart + 1.0, peakStart + 2.0]
      .filter(t => t >= 0);
    console.log(`[RECONNECT] clipId=${rcId} scanning for bright frame near t=${peakStart}s`);
    peakStart = findBrightFrame(src, candidates);
    rcSs  = Math.max(0, peakStart - 1.0);
    rcDur = 2.1;
    console.log(`[RECONNECT] clipId=${rcId} peakStart=${peakStart}`);
  }

  const out = path.resolve(projectDir, 'edit/reconnecting.mp4');

  // Ensure reconnecting panel MKV exists
  const panelPath = path.join(CACHE_DIR, 'reconnecting-panel.mkv');
  if (!fs.existsSync(panelPath)) {
    console.log('  [RENDER] reconnecting panel...');
    const r = spawnSync('node', [
      path.resolve('scripts/render-overlay.js'), 'reconnecting', panelPath
    ], { stdio: 'inherit' });
    if (r.status !== 0) console.error('render-overlay failed for reconnecting panel');
  } else {
    console.log('  [CACHE] reconnecting panel');
  }

  const bwFilter = 'setpts=PTS-STARTPTS,eq=saturation=0:contrast=1.25:brightness=-0.05';
  const glitchFilter = "noise=alls=25:allf=t+u,hue=H='if(mod(floor(t*13),2), 1.57, 0)'";

  if (!fs.existsSync(panelPath)) {
    const ok = await ffrunAsync([
      '-ss', String(rcSs), '-t', String(rcDur), '-i', src,
      '-vf', `${bwFilter},${glitchFilter}`,
      '-t', String(rcDur),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-r', '30', '-y', out
    ]);
    if (ok) console.log(`[OK] reconnecting.mp4 (no panel)`);
    return;
  }

  const ok = await ffrunAsync([
    '-ss', String(rcSs), '-t', String(rcDur), '-i', src,
    '-i', panelPath,
    '-filter_complex', [
      `[0:v]${bwFilter}[bw]`,
      '[bw][1:v]overlay=0:0:format=auto[composite]',
      `[composite]${glitchFilter}[out]`
    ].join(';'),
    '-map', '[out]', '-map', '0:a',
    '-t', String(rcDur),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-r', '30', '-y', out
  ]);
  if (ok) console.log(`[OK] reconnecting.mp4`);
}

// --- MAIN ---
async function main() {
  console.log(`\n=== apply-overlays.js — ${projectDir} ===\n`);

  // Build ordered clip list with consecutive same-streamer detection
  const orderedClips = [];
  for (const group of plan.groups) {
    for (const clipId of (Array.isArray(group) ? group : group.clipIds)) {
      orderedClips.push({ clipId, broadcaster: broadcasters[clipId] || 'Unknown' });
    }
  }

  // Any clips in clipOrder not in groups
  const groupClipIds = new Set(orderedClips.map(c => c.clipId));
  for (const clipId of plan.clipOrder) {
    if (String(clipId).startsWith('__recon')) continue;
    if (!groupClipIds.has(clipId)) {
      orderedClips.push({ clipId, broadcaster: broadcasters[clipId] || 'Unknown' });
    }
  }

  // Pre-compute banner flags (consecutive same-streamer → no banner)
  let prev = null;
  const clipsWithFlags = orderedClips.map(({ clipId, broadcaster }) => {
    const skipBanner = broadcaster === prev;
    prev = broadcaster;
    return { clipId, broadcaster, skipBanner };
  });

  // PASS 1: Pre-render all missing banner MKVs in parallel
  const needRender = [...new Set(
    clipsWithFlags
      .filter(c => !c.skipBanner)
      .map(c => c.broadcaster)
      .filter(name => !fs.existsSync(path.join(CACHE_DIR, `${slug(name)}.mkv`)))
  )];

  if (needRender.length > 0) {
    console.log(`[PASS 1] Rendering ${needRender.length} new banner MKVs (parallel: ${PUPPETEER_CONCURRENCY})...`);
    let pi = 0;
    async function bannerWorker() {
      while (pi < needRender.length) {
        const name = needRender[pi++];
        const outPath = path.join(CACHE_DIR, `${slug(name)}.mkv`);
        await renderBannerAsync(name, outPath, avatarByDisplayName[name]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(PUPPETEER_CONCURRENCY, needRender.length) }, bannerWorker));
  } else {
    console.log('[PASS 1] All banner MKVs cached, skipping render.');
  }

  // PASS 2: Apply FFmpeg overlays for all clips in parallel
  console.log(`\n[PASS 2] Applying overlays to ${clipsWithFlags.length} clips (parallel: ${FFMPEG_CONCURRENCY})...`);
  let okCount = 0, failCount = 0;
  let ci = 0;
  async function overlayWorker() {
    while (ci < clipsWithFlags.length) {
      const { clipId, broadcaster, skipBanner } = clipsWithFlags[ci++];
      if (await applyStreamerOverlay(clipId, broadcaster, skipBanner)) okCount++; else failCount++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(FFMPEG_CONCURRENCY, clipsWithFlags.length) }, overlayWorker));

  await renderReconnecting();

  updateState(projectDir, s => {
    s.stages = s.stages || {};
    s.stages.overlays = stageStatus(okCount, failCount);
    s.stages.reconnecting = 'done';
  });

  console.log(`\nDone. ${okCount} ok, ${failCount} failed.\n`);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
