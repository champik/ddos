const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const streamerName = args[0];
const outPath = args[1];
const type = args[2] || 'streamer'; // 'streamer' or 'reconnecting'

async function main() {
  let htmlPath, htmlContent;

  if (type === 'reconnecting') {
    htmlPath = 'd:/Projects/ddos/assets/overlays/reconnecting.html';
  } else {
    htmlPath = 'd:/Projects/ddos/assets/streamer-overlay/streamer_name.html';
  }

  htmlContent = fs.readFileSync(htmlPath, 'utf8');

  // Embed logo.svg as base64
  const logoPath = 'd:/Projects/ddos/assets/thumbnail-template/logo.svg';
  if (fs.existsSync(logoPath)) {
    const logoB64 = fs.readFileSync(logoPath).toString('base64');
    htmlContent = htmlContent.replace(/\.\/logo\.svg/g, 'data:image/svg+xml;base64,' + logoB64);
    htmlContent = htmlContent.replace(/['"]logo\.svg['"]/g, '"data:image/svg+xml;base64,' + logoB64 + '"');
  }

  if (type === 'streamer' && streamerName) {
    // Replace placeholder streamer name - common patterns
    htmlContent = htmlContent.replace(/@NORTHERNLION_OFFICIAL/gi, '@' + streamerName.toUpperCase());
    htmlContent = htmlContent.replace(/NORTHERNLION_OFFICIAL/gi, streamerName.toUpperCase());
    htmlContent = htmlContent.replace(/northernlion_official/gi, streamerName.toUpperCase());
    htmlContent = htmlContent.replace(/STREAMER_NAME/gi, streamerName.toUpperCase());
  }

  const tmpHtml = outPath.replace('.png', '_tmp.html');
  fs.writeFileSync(tmpHtml, htmlContent, 'utf8');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('file://' + path.resolve(tmpHtml), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: outPath, type: 'png', omitBackground: true });
  await browser.close();

  // Clean up tmp
  try { fs.unlinkSync(tmpHtml); } catch(e) {}
  console.log('OK: ' + outPath);
}

main().catch(e => { console.error('ERR: ' + e.message); process.exit(1); });
