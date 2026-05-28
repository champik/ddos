'use strict';
const fs   = require('fs');
const path = require('path');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node rebuild-concat.js <projectDir>'); process.exit(1); }

const editorial = JSON.parse(fs.readFileSync(path.join(projectDir, 'edit/editorial.json'), 'utf8'));
const BASE = 'D:/Projects/ddos';
const projAbs = path.resolve(projectDir).replace(/\\/g, '/');

const INTRO    = "file '" + BASE + "/assets/intro/intro_30fps.mp4'";
const OUTRO    = "file '" + BASE + "/assets/outro/outro_30fps.mp4'";
const RECONNECT = "file '" + projAbs + "/edit/reconnecting.mp4'";

const reconnectSet = new Set(editorial.reconnectPositions || []);
const lines = [INTRO];

for (const clipId of editorial.clipOrder) {
  const clipPath = projAbs + '/processed/' + clipId + '/overlayed.mp4';
  lines.push("file '" + clipPath + "'");
  if (reconnectSet.has(clipId)) {
    lines.push(RECONNECT);
  }
}

lines.push(OUTRO);

const content = lines.join('\n') + '\n';
console.log('=== New concat-list.txt ===\n' + content);

const outPath = path.join(projectDir, 'edit/concat-list.txt');
fs.writeFileSync(outPath, content, 'ascii');
console.log('Written:', outPath);
console.log('Reconnect positions (' + reconnectSet.size + '):', [...reconnectSet].map(id => id.substring(0,30)));
