'use strict';
// Usage: node scripts/render-thumbnail.js <framePath> <headlineText> <outPath>
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function render(framePath, headline, outPath) {
  let html = fs.readFileSync('assets/thumbnail-template/thumbnail.html', 'utf8');

  const frameB64 = fs.readFileSync(framePath).toString('base64');
  const frameDataUrl = 'data:image/png;base64,' + frameB64;

  // JSON.stringify коректно екранує і лапки, і бекслеші в headline
  const config = `var THUMB_CONFIG = { headline: ${JSON.stringify(headline)}, img: '${frameDataUrl}' }`;
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

const [framePath, headline, outPath] = process.argv.slice(2);

if (!framePath || !outPath) {
  console.error('Usage: node render-thumbnail.js <framePath> <headline> <outPath>');
  process.exit(1);
}
render(framePath, headline, outPath).catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
