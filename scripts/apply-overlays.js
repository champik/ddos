'use strict';
// apply-overlays.js — renders streamer banners + reconnecting clip using Puppeteer-rendered MKV overlays
// Two-pass: (1) pre-render all missing banner MKVs in parallel, (2) apply FFmpeg overlays in parallel.
// Usage: node scripts/apply-overlays.js <projectDir>

const fs   = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readJson, readJsonSafe, updateState, stageStatus } = require('./lib/state');
const { getDuration, hasAudioStream, hasVideoStream, isSilent } = require('./lib/media-probe');
const { mapToCleanTimeline } = require('./lib/timeline');

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

const DEFAULT_RECON_DUR = 2.1;
const MIN_RECON_DUR     = 0.8;   // коротше — це вже не перебивка, а мигання
const RECON_DUR_TOLERANCE = 0.15;

// Перевірка готового reconnecting.mp4. ffmpeg виходить з кодом 0 і тоді, коли
// -ss вийшов за кінець файлу і на виході майже нічого немає — тому самого
// exit code не досить, треба дивитись на результат.
function verifyReconnecting(out, expectedDur) {
  if (!fs.existsSync(out)) return 'файл не створено';
  const dur = getDuration(out);
  if (Math.abs(dur - expectedDur) > RECON_DUR_TOLERANCE) {
    return `тривалість ${dur.toFixed(2)}s замість ${expectedDur.toFixed(2)}s`;
  }
  if (!hasVideoStream(out)) return 'немає відео-доріжки';
  if (!hasAudioStream(out)) return 'немає аудіо-доріжки';
  if (isSilent(out) === true) return 'звук пропав — доріжка німа';
  const y = frameBrightness(out, dur / 2);
  if (y < 5) return `чорна картинка (Y=${y.toFixed(1)})`;
  return null;
}

async function renderReconnecting() {
  const rcId = plan.reconnectingClipId;
  if (!rcId) { console.log('[SKIP] No reconnectingClipId'); return 'skipped'; }

  let editorialFrom = null, editorialTo = null, keeps = null, inT = 0, outT = Infinity;
  try {
    const ed = readJson(path.resolve(projectDir, 'edit/editorial.json'));
    if (ed.reconnectSource?.clipId === rcId) {
      editorialFrom = ed.reconnectSource.from ?? null;
      editorialTo   = ed.reconnectSource.to   ?? null;
    }
    const clipEdits = ed.clips?.[rcId] || {};
    keeps = clipEdits.keeps || null;
    inT   = clipEdits.trim?.in ?? 0;
    outT  = clipEdits.trim?.out ?? Infinity;
  } catch {}

  // Завжди береться clean.mp4 (VOD-замінений якщо є), а не оригінальний завантажений файл.
  let src = path.resolve(projectDir, 'processed', rcId, 'clean.mp4');
  if (!fs.existsSync(src)) src = path.resolve(projectDir, 'processed', rcId, 'overlayed.mp4');
  if (!fs.existsSync(src)) {
    console.error(`[RECONNECT] ✗ немає вихідного файлу для ${rcId}`);
    return 'failed';
  }

  const srcDur = getDuration(src);
  if (srcDur <= 0) {
    console.error(`[RECONNECT] ✗ не читається тривалість ${src}`);
    return 'failed';
  }

  let rcSs = null, rcDur = null;

  if (editorialFrom != null && editorialTo != null) {
    const mapped = mapToCleanTimeline(editorialFrom, keeps, inT, outT);
    if (mapped === null) {
      console.error(
        `[RECONNECT] ✗ editorial from=${editorialFrom}s потрапляє у вирізаний фрагмент ${rcId} — ` +
        `reconnectSource застарів відносно keeps/trim. Відкат на пошук яскравого кадру.`
      );
    } else if (editorialTo <= editorialFrom) {
      console.error(`[RECONNECT] ✗ editorial to=${editorialTo} <= from=${editorialFrom}. Відкат на пошук яскравого кадру.`);
    } else {
      rcSs  = Math.max(0, mapped);
      rcDur = editorialTo - editorialFrom;
      console.log(`[RECONNECT] clipId=${rcId} editorial from=${editorialFrom} to=${editorialTo} mapped=${mapped.toFixed(3)} → ss=${rcSs.toFixed(3)} dur=${rcDur.toFixed(2)}s (clean=${srcDur.toFixed(2)}s)`);
    }
  }

  if (rcSs === null) {
    const peakBase = mapToCleanTimeline(editorialFrom ?? 0, keeps, inT, outT) ?? 0;
    const candidates = [peakBase, peakBase + 0.5, peakBase - 0.5, peakBase + 1.0, peakBase + 2.0]
      .filter(t => t >= 0 && t < srcDur);
    if (candidates.length === 0) candidates.push(0);
    console.log(`[RECONNECT] clipId=${rcId} scanning for bright frame near t=${peakBase.toFixed(2)}s`);
    const peakStart = findBrightFrame(src, candidates);
    rcSs  = Math.max(0, peakStart - 1.0);
    rcDur = DEFAULT_RECON_DUR;
    console.log(`[RECONNECT] clipId=${rcId} peakStart=${peakStart}`);
  }

  // Клемп у межі файлу. Вихід за кінець — не привід мовчки різати: саме так
  // «взяти з 13 по 17» на 15-секундному кліпі давало порожню перебивку.
  if (rcSs >= srcDur - MIN_RECON_DUR) {
    console.error(`[RECONNECT] ✗ ss=${rcSs.toFixed(2)}s за межами кліпу (${srcDur.toFixed(2)}s) — перебивку не зроблено`);
    return 'failed';
  }
  const available = srcDur - rcSs;
  if (rcDur > available) {
    console.warn(`[RECONNECT] ⚠ запит ${rcDur.toFixed(2)}s, доступно ${available.toFixed(2)}s — обрізаю`);
    rcDur = available;
  }
  if (rcDur < MIN_RECON_DUR) {
    console.error(`[RECONNECT] ✗ лишилось ${rcDur.toFixed(2)}s — замало на перебивку`);
    return 'failed';
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

  const hasPanel = fs.existsSync(panelPath);
  const ok = hasPanel
    ? await ffrunAsync([
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
      ])
    : await ffrunAsync([
        '-ss', String(rcSs), '-t', String(rcDur), '-i', src,
        '-vf', `${bwFilter},${glitchFilter}`,
        '-t', String(rcDur),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-r', '30', '-y', out
      ]);

  const err = ok ? verifyReconnecting(out, rcDur) : 'ffmpeg завершився з помилкою';
  if (err) {
    // Битий файл не лишаємо: build-concat.js вставляє перебивку за самим лише
    // fs.existsSync, і файл на 0.04s пройшов би цю перевірку.
    fs.rmSync(out, { force: true });
    console.error(`[RECONNECT] ✗ ${err} — reconnecting.mp4 видалено, епізод піде без перебивки`);
    return 'failed';
  }

  console.log(`[OK] reconnecting.mp4 (${rcDur.toFixed(2)}s${hasPanel ? '' : ', no panel'})`);
  return 'done';
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

  const reconStatus = await renderReconnecting();

  updateState(projectDir, s => {
    s.stages = s.stages || {};
    s.stages.overlays = stageStatus(okCount, failCount);
    // Раніше тут завжди стояло 'done' — навіть коли перебивка вийшла порожньою.
    s.stages.reconnecting = reconStatus;
  });

  console.log(`\nDone. ${okCount} ok, ${failCount} failed. Reconnect: ${reconStatus}.\n`);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
