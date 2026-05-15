#!/usr/bin/env node
// render-overlay.js — renders animated HTML overlays to WebM with alpha channel
// Modes:
//   node render-overlay.js streamer <name> <out.webm>   — streamer name overlay (3s, 30fps)
//   node render-overlay.js reconnecting <out.webm>      — reconnecting panel (3s, 30fps)
'use strict';
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const FPS = 30;
const DURATION_S = 3;
const FRAMES = FPS * DURATION_S;

async function captureFrames(html, width, height, framesDir) {
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

  for (let i = 0; i < FRAMES; i++) {
    const timeMs = (i / FRAMES) * DURATION_S * 1000;
    await page.evaluate((t) => {
      document.getAnimations().forEach(a => { a.currentTime = t; });
    }, timeMs);
    await new Promise(r => setTimeout(r, 16)); // allow repaint
    await page.screenshot({
      path: path.join(framesDir, `frame_${String(i).padStart(4, '0')}.png`),
      type: 'png',
      omitBackground: true
    });
  }

  await browser.close();
  fs.unlinkSync(tmpHtml);
}

function compileWebm(framesDir, outputPath) {
  const cmd = [
    'ffmpeg', '-y',
    '-framerate', String(FPS),
    '-i', path.join(framesDir, 'frame_%04d.png'),
    '-c:v', 'libvpx-vp9',
    '-pix_fmt', 'yuva420p',
    '-b:v', '0', '-crf', '25',
    '-auto-alt-ref', '0',
    outputPath
  ].join(' ');
  execSync(cmd, { stdio: 'pipe' });
}

function inlineLogoSvg(html) {
  const logoPath = 'assets/thumbnail-template/logo.svg';
  if (!fs.existsSync(logoPath)) return html;
  const b64 = fs.readFileSync(logoPath).toString('base64');
  return html.replace(/['"]\.\/logo\.svg['"]/g, `"data:image/svg+xml;base64,${b64}"`);
}

async function renderStreamer(name, outputPath) {
  let html = fs.readFileSync('assets/streamer-overlay/streamer_name.html', 'utf8');
  html = inlineLogoSvg(html);
  html = html.replace(/NORTHERNLION_OFFICIAL/g, name.toUpperCase());

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddos-str-'));
  try {
    await captureFrames(html, 1920, 1080, tmpDir);
    compileWebm(tmpDir, outputPath);
    console.log(`Streamer overlay (${name}) → ${outputPath}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function renderReconnecting(outputPath) {
  let html = fs.readFileSync('assets/overlays/reconnecting.html', 'utf8');
  html = inlineLogoSvg(html);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddos-rc-'));
  try {
    await captureFrames(html, 1920, 1080, tmpDir);
    compileWebm(tmpDir, outputPath);
    console.log(`Reconnecting panel → ${outputPath}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const [,, mode, ...args] = process.argv;
if (mode === 'streamer' && args.length >= 2) {
  renderStreamer(args[0], args[1]).catch(e => { console.error(e.message); process.exit(1); });
} else if (mode === 'reconnecting' && args.length >= 1) {
  renderReconnecting(args[0]).catch(e => { console.error(e.message); process.exit(1); });
} else {
  console.error('Usage: node render-overlay.js streamer <name> <out.webm>');
  console.error('       node render-overlay.js reconnecting <out.webm>');
  process.exit(1);
}
