'use strict';
// Usage: node scripts/render-thumbnail.js <framePath> <headlineText> <outPath> [--size <px>]
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function render(framePath, headline, outPath, fontSize) {
  let html = fs.readFileSync('assets/thumbnail-template/thumbnail.html', 'utf8');

  const frameB64 = fs.readFileSync(framePath).toString('base64');
  const frameDataUrl = 'data:image/png;base64,' + frameB64;

  const config = `var THUMB_CONFIG = { headline: '${headline.replace(/'/g, "\\'")}', img: '${frameDataUrl}'${fontSize ? ', fontSize: ' + fontSize : ''} }`;
  html = html.replace(/var THUMB_CONFIG = \{[^}]+\}/, config);

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

const args = process.argv.slice(2);
const sizeIdx = args.indexOf('--size');
const fontSize = sizeIdx !== -1 ? parseInt(args[sizeIdx + 1]) : null;
const [framePath, headline, outPath] = args.filter((_, i) => i !== sizeIdx && i !== sizeIdx + 1);

if (!framePath || !headline || !outPath) {
  console.error('Usage: node render-thumbnail.js <framePath> <headline> <outPath> [--size <px>]');
  process.exit(1);
}
render(framePath, headline, outPath, fontSize).catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
