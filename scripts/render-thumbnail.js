'use strict';
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function render(framePath, episodeNumber, headline, outPath) {
  let html = fs.readFileSync('assets/thumbnail-template/thumbnail.html', 'utf8');

  const frameB64 = fs.readFileSync(framePath).toString('base64');
  const frameDataUrl = 'data:image/png;base64,' + frameB64;

  const logoB64 = fs.readFileSync('assets/thumbnail-template/logo.svg').toString('base64');
  const logoDataUrl = 'data:image/svg+xml;base64,' + logoB64;

  html = html.replace(
    /var THUMB_CONFIG = \{[^}]+\}/,
    `var THUMB_CONFIG = { ep: ${episodeNumber}, headline: '${headline.replace(/'/g, "\\'")}', img: '${frameDataUrl}', variant: 'A' }`
  );
  html = html.replace('./logo.svg', logoDataUrl);

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

const [,, framePath, ep, headline, outPath] = process.argv;
render(framePath, parseInt(ep), headline, outPath).catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
