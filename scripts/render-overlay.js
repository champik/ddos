#!/usr/bin/env node
// render-overlay.js — renders animated HTML overlays to FFV1 MKV with alpha channel
// Modes:
//   node render-overlay.js streamer <name> <out.mkv>   — streamer name overlay (5s, 30fps)
//   node render-overlay.js reconnecting <out.mkv>      — reconnecting panel (3s, 30fps)
'use strict';
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');

const FPS = 30;
const DURATION_S = 5;

async function captureFrames(html, width, height, framesDir, durationS = DURATION_S) {
  const frames = Math.round(FPS * durationS);
  const tmpHtml = path.join(framesDir, '_overlay.html');
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(`file://${path.resolve(tmpHtml)}`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 800)); // wait for fonts

  // Pause all animations and control them manually
  await page.evaluate(() => {
    document.getAnimations().forEach(a => { a.pause(); a.currentTime = 0; });
  });

  for (let i = 0; i < frames; i++) {
    const timeMs = (i / frames) * durationS * 1000;
    await page.evaluate((t) => {
      document.getAnimations().forEach(a => { a.currentTime = t; });
      document.documentElement.getBoundingClientRect(); // flush style recalc
    }, timeMs);
    // Two rAF cycles guarantee the compositor committed the new frame before screenshot
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({
      path: path.join(framesDir, `frame_${String(i).padStart(4, '0')}.png`),
      type: 'png',
      omitBackground: true
    });
  }

  await browser.close();
  fs.unlinkSync(tmpHtml);
}

function compileOverlay(framesDir, outputPath) {
  // FFV1 in MKV preserves alpha correctly on Windows (VP9/VP8 do not)
  const r = spawnSync('ffmpeg', [
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(framesDir, 'frame_%04d.png'),
    '-c:v', 'ffv1',
    '-pix_fmt', 'yuva420p',
    outputPath
  ], { stdio: 'pipe', encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr.slice(-300));
}

function inlineLogoSvg(html) {
  const logoPath = 'assets/thumbnail-template/logo.svg';
  if (!fs.existsSync(logoPath)) return html;
  const b64 = fs.readFileSync(logoPath).toString('base64');
  return html.replace(/['"]\.\/logo\.svg['"]/g, `"data:image/svg+xml;base64,${b64}"`);
}

async function renderOverlay({ htmlFile, replacements = {}, width, height, durationS = DURATION_S, outputPath }) {
  let html = fs.readFileSync(htmlFile, 'utf8');
  html = inlineLogoSvg(html);
  for (const [from, to] of Object.entries(replacements)) {
    html = html.replace(new RegExp(from, 'g'), to);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddos-ov-'));
  try {
    await captureFrames(html, width, height, tmpDir, durationS);
    compileOverlay(tmpDir, outputPath);
    console.log(`${path.basename(htmlFile)} → ${outputPath}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function renderStreamer(name, outputPath, avatarUrl) {
  let html = fs.readFileSync('assets/streamer-overlay/streamer_name.html', 'utf8');
  html = inlineLogoSvg(html);

  // Replace streamer name in element with data-ddos-name attribute
  html = html.replace(/(<[^>]+data-ddos-name[^>]*>)[^<]*/g, `$1${name}`);

  // Replace avatar block
  if (avatarUrl) {
    html = html.replace(/<img[^>]+data-ddos-avatar[^>]*>/g,
      `<img data-ddos-avatar src="${avatarUrl}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;display:block;">`);
  } else {
    html = html.replace(/<div class="ddos-streamer__av">[\s\S]*?<\/div>/g, '');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddos-ov-'));
  try {
    await captureFrames(html, 1920, 1080, tmpDir);
    compileOverlay(tmpDir, outputPath);
    console.log(`streamer_name.html → ${outputPath}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Single static PNG of the #so name-tag block (not the full 1920x1080 frame,
// not animated) — for manual placement in CapCut instead of a burned-in
// video overlay. Viewport stays 1920x1080 so the block's CSS (bottom/left %,
// adaptive width) renders identically to the video-overlay path; only the
// element itself is captured.
// Fixed canvas width/height every streamer-name PNG gets padded (transparently)
// up to, regardless of nickname length or avatar presence — CapCut scales
// imported images to a target size on drop, so two source PNGs of different
// native size (e.g. a short "xQc" tag vs a long "wendolynortizz" tag; or a
// streamer with an avatar — 70px tall block — vs one without — 62px tall)
// land at different visual scales unless every export shares the same canvas.
// The real block stays anchored at its natural size in the top-left corner;
// only empty transparent space is added to the right/bottom. Both are a
// floor, not a cap: a block bigger than these (a very long nickname, or some
// future taller variant) still gets its full size rather than being cropped.
const STREAMER_CANVAS_WIDTH = 500;
const STREAMER_CANVAS_HEIGHT = 70;

async function captureStreamerStatic(html, width, height, outputPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddos-ov-'));
  const tmpHtml = path.join(tmpDir, '_overlay.html');
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(`file://${path.resolve(tmpHtml)}`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 800)); // wait for fonts

    // Settle the entrance animation mid-hold (fully slid in, not yet exiting).
    await page.evaluate(() => {
      document.getAnimations().forEach(a => {
        a.pause();
        const dur = a.effect.getTiming().duration;
        a.currentTime = typeof dur === 'number' ? dur * 0.5 : 0;
      });
      document.documentElement.getBoundingClientRect(); // flush style recalc
    });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

    const el = await page.$('#so');
    if (!el) throw new Error('#so element not found in streamer_name.html');
    const box = await el.boundingBox();
    if (!box) throw new Error('#so element has no bounding box (not rendered/visible)');

    await page.screenshot({
      path: outputPath,
      type: 'png',
      omitBackground: true,
      clip: {
        x: box.x,
        y: box.y,
        width: Math.max(STREAMER_CANVAS_WIDTH, Math.ceil(box.width)),
        height: Math.max(STREAMER_CANVAS_HEIGHT, Math.ceil(box.height)),
      },
    });
  } finally {
    await browser.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// meta: { views?: string, date?: string, rank?: number|string } — all three
// are opt-in. Default (no meta / meta.views omitted) = the plain classic tag,
// name + avatar only, nothing else shown. Only ranking-style episodes (e.g.
// TopClips) pass meta, which turns on the views/date row and — if meta.rank
// is also given — the "#N" rank badge (a normal episode has no "#N" concept).
async function renderStreamerStatic(name, outputPath, avatarUrl, meta = {}) {
  let html = fs.readFileSync('assets/streamer-overlay/streamer_name.html', 'utf8');
  html = inlineLogoSvg(html);

  html = html.replace(/(<[^>]+data-ddos-name[^>]*>)[^<]*/g, `$1${name}`);

  if (avatarUrl) {
    html = html.replace(/<img[^>]+data-ddos-avatar[^>]*>/g,
      `<img data-ddos-avatar src="${avatarUrl}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;display:block;">`);
  } else {
    html = html.replace(/<div class="ddos-streamer__av">[\s\S]*?<\/div>/g, '');
  }

  if (meta.views != null) {
    html = html.replace(/(<[^>]+data-ddos-views[^>]*>)[^<]*/g, `$1${meta.views}`);
    if (meta.date != null) html = html.replace(/(<[^>]+data-ddos-date[^>]*>)[^<]*/g, `$1${meta.date}`);
  } else {
    html = html.replace(/<div class="ddos-streamer__meta">[\s\S]*?<\/div>/, '');
  }

  if (meta.rank != null) {
    html = html.replace(/(<[^>]+data-ddos-rank[^>]*>)[^<]*/g, `$1#${meta.rank}`);
  } else {
    html = html.replace(/<div class="ddos-streamer__rank"[\s\S]*?<\/div>/, '');
  }

  // 1/255 background alpha across the whole page — imperceptible to the eye,
  // but keeps every pixel in the padded canvas at alpha>0. Some editors
  // (CapCut confirmed) auto-trim PNGs down to their fully-transparent
  // (alpha=0) bounding box on import, which would silently undo the fixed
  // 500x70 canvas below. Scoped to this static-PNG path only — the animated
  // video-overlay path (renderStreamer) still wants true alpha=0 padding
  // since it's composited with ffmpeg overlay, not re-imported as a still.
  html = html.replace('</head>', '<style>html,body{background:rgba(0,0,0,0.004);}</style></head>');

  await captureStreamerStatic(html, 1920, 1080, outputPath);
  console.log(`streamer_name.html (static) → ${outputPath}`);
}

async function renderReconnecting(outputPath, durationS = DURATION_S) {
  await renderOverlay({
    htmlFile: 'assets/overlays/reconnecting.html',
    width: 1920, height: 1080, durationS, outputPath,
  });
}

// 2 heartbeat cycles at 2.4s each = 4.8s; loops seamlessly via -stream_loop
async function renderShortsHeader(name, outputPath) {
  await renderOverlay({
    htmlFile: 'assets/overlays/shorts-header-pulse.html',
    replacements: { 'STREAMER_PLACEHOLDER': name.toUpperCase() },
    width: 1080, height: 1920, durationS: 4.8, outputPath,
  });
}

const [,, mode, ...args] = process.argv;
if (mode === 'streamer' && args.length >= 2) {
  renderStreamer(args[0], args[1], args[2] || null).catch(e => { console.error(e.message); process.exit(1); });
} else if (mode === 'streamer-static' && args.length >= 2) {
  const meta = args[3] ? JSON.parse(args[3]) : {};
  renderStreamerStatic(args[0], args[1], args[2] || null, meta).catch(e => { console.error(e.message); process.exit(1); });
} else if (mode === 'reconnecting' && args.length >= 1) {
  const durationS = args[1] ? parseFloat(args[1]) : undefined;
  renderReconnecting(args[0], durationS).catch(e => { console.error(e.message); process.exit(1); });
} else if (mode === 'shorts-header' && args.length >= 2) {
  renderShortsHeader(args[0], args[1]).catch(e => { console.error(e.message); process.exit(1); });
} else {
  console.error('Usage: node render-overlay.js streamer <name> <out.mkv>');
  console.error('       node render-overlay.js streamer-static <name> <out.png> [avatarUrl] [metaJson]');
  console.error('       node render-overlay.js reconnecting <out.mkv> [durationS]');
  console.error('       node render-overlay.js shorts-header <name> <out.png>');
  process.exit(1);
}
