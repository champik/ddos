#!/usr/bin/env node
// screenshot-thumbnail.js <outPath>
// Screenshots assets/thumbnail-template/thumbnail.html EXACTLY as it is on disk —
// no image/hook injection. User hand-edits the template (headline text, and drops
// their own background image at assets/thumbnail-template/thumbnail.png) before
// running this; this script just captures that result at 1920x1080.
'use strict';
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const TEMPLATE = path.resolve('assets/thumbnail-template/thumbnail.html');

async function main(outPath) {
  if (!fs.existsSync(TEMPLATE)) {
    console.error('Template not found:', TEMPLATE);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto('file://' + TEMPLATE, { waitUntil: 'networkidle0', timeout: 15000 });
  await new Promise(r => setTimeout(r, 500)); // fonts/layout settle
  await page.screenshot({ path: outPath, type: 'png' });
  await browser.close();

  console.log('Thumbnail:', outPath);
}

const [outPath] = process.argv.slice(2);
if (!outPath) {
  console.error('Usage: node scripts/screenshot-thumbnail.js <outPath>');
  process.exit(1);
}
main(outPath).catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
