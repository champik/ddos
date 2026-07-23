'use strict';
// Usage: node scripts/lib/svg-to-png.js <svgPath> <pngPath> <width> <height>
const [,, svgPath, pngPath, wStr, hStr] = process.argv;
const W = parseInt(wStr) || 140, H = parseInt(hStr) || 195;

(async () => {
  const puppeteer = require('puppeteer');
  const fs = require('fs');
  const svg = fs.readFileSync(svgPath, 'utf8')
    .replace(/width="[^"]*"/, `width="${W}"`)
    .replace(/height="[^"]*"/, `height="${H}"`);
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
  await page.setContent(`<!DOCTYPE html><html><head><style>html,body{margin:0;padding:0;background:transparent;width:${W}px;height:${H}px;overflow:hidden}</style></head><body>${svg}</body></html>`);
  await page.screenshot({ path: pngPath, omitBackground: true });
  await browser.close();
})();
