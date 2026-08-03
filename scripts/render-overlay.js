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
  html = html.replace(/(<[^>]+data-ddos-name[^>]*>)[^<]*/g, `$1${name.toUpperCase()}`);

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
    await el.screenshot({ path: outputPath, type: 'png', omitBackground: true });
  } finally {
    await browser.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function renderStreamerStatic(name, outputPath, avatarUrl) {
  let html = fs.readFileSync('assets/streamer-overlay/streamer_name.html', 'utf8');
  html = inlineLogoSvg(html);

  html = html.replace(/(<[^>]+data-ddos-name[^>]*>)[^<]*/g, `$1${name.toUpperCase()}`);

  if (avatarUrl) {
    html = html.replace(/<img[^>]+data-ddos-avatar[^>]*>/g,
      `<img data-ddos-avatar src="${avatarUrl}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;display:block;">`);
  } else {
    html = html.replace(/<div class="ddos-streamer__av">[\s\S]*?<\/div>/g, '');
  }

  await captureStreamerStatic(html, 1920, 1080, outputPath);
  console.log(`streamer_name.html (static) → ${outputPath}`);
}

async function renderReconnecting(outputPath) {
  await renderOverlay({
    htmlFile: 'assets/overlays/reconnecting.html',
    width: 1920, height: 1080, outputPath,
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
  renderStreamerStatic(args[0], args[1], args[2] || null).catch(e => { console.error(e.message); process.exit(1); });
} else if (mode === 'reconnecting' && args.length >= 1) {
  renderReconnecting(args[0]).catch(e => { console.error(e.message); process.exit(1); });
} else if (mode === 'shorts-header' && args.length >= 2) {
  renderShortsHeader(args[0], args[1]).catch(e => { console.error(e.message); process.exit(1); });
} else {
  console.error('Usage: node render-overlay.js streamer <name> <out.mkv>');
  console.error('       node render-overlay.js streamer-static <name> <out.png> [avatarUrl]');
  console.error('       node render-overlay.js reconnecting <out.mkv>');
  console.error('       node render-overlay.js shorts-header <name> <out.png>');
  process.exit(1);
}
