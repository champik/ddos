'use strict';
// Usage: node scripts/render-thumbnail.js <framePath> <headlineText> <outPath> [--size <px>]
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function render(framePath, headline, outPath, fontSize, crop) {
  let html = fs.readFileSync('assets/thumbnail-template/thumbnail.html', 'utf8');

  const frameB64 = fs.readFileSync(framePath).toString('base64');
  const frameDataUrl = 'data:image/png;base64,' + frameB64;

  const cropStr = crop ? ', crop: ' + JSON.stringify(crop) : '';
  // JSON.stringify коректно екранує і лапки, і бекслеші в headline
  const config = `var THUMB_CONFIG = { headline: ${JSON.stringify(headline)}, img: '${frameDataUrl}'${fontSize ? ', fontSize: ' + fontSize : ''}${cropStr} }`;
  html = html.replace(/var THUMB_CONFIG = \{[\s\S]*?\};/, config + ';');

  const tmpHtml = outPath.replace('.png', '_tmp.html');
  fs.writeFileSync(tmpHtml, html);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-web-security', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('file://' + path.resolve(tmpHtml), { waitUntil: 'networkidle0', timeout: 15000 });
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: outPath, type: 'png' });
  await browser.close();

  try { fs.unlinkSync(tmpHtml); } catch {}
  console.log('Thumbnail:', outPath);
}

const rawArgs = process.argv.slice(2);

function popFlag(arr, flag) {
  const idx = arr.indexOf(flag);
  if (idx === -1) return null;
  const val = arr[idx + 1];
  arr.splice(idx, 2);
  return val;
}

const sizeRaw = popFlag(rawArgs, '--size');
const fontSize = sizeRaw ? parseInt(sizeRaw) : null;
const cropRaw = popFlag(rawArgs, '--crop');
const crop = cropRaw ? JSON.parse(cropRaw) : null;
const noTextIdx = rawArgs.indexOf('--no-text');
const noText = noTextIdx !== -1;
if (noText) rawArgs.splice(noTextIdx, 1);
const [framePath, headlineOrOut, outPathOrUndef] = rawArgs;
const headline = noText ? '' : headlineOrOut;
const outPath = noText ? headlineOrOut : outPathOrUndef;

if (!framePath || !outPath) {
  console.error('Usage: node render-thumbnail.js <framePath> <headline> <outPath> [--size <px>] [--crop <json>] [--no-text]');
  process.exit(1);
}
render(framePath, headline, outPath, fontSize, crop).catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
