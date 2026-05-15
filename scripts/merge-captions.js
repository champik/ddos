#!/usr/bin/env node
// Merges multiple per-clip ASS caption files into one episode ASS file with time offsets.
// Usage: node scripts/merge-captions.js <segments.json> <output.ass>
// segments.json: [{"assFile": "path/to/file.ass", "offset": 12.5}, ...]
'use strict';
const fs = require('fs');

function parseAssTime(t) {
  const [h, m, rest] = t.trim().split(':');
  const [s, cs] = rest.split('.');
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(cs || 0) / 100;
}

function formatAssTime(secs) {
  if (secs < 0) secs = 0;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const cs = Math.round((secs % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

const HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, Outline, Alignment, MarginV
Style: Default,Archivo Black,56,&H00F4F0E6,&H000E0E10,-1,3,2,80
Style: Hot,Archivo Black,56,&H00F5FF3D,&H000E0E10,-1,3,2,80

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

function mergeAss(segments) {
  const dialogues = [];
  for (const { assFile, offset } of segments) {
    if (!fs.existsSync(assFile)) {
      console.warn(`Warning: ASS not found: ${assFile}`);
      continue;
    }
    const lines = fs.readFileSync(assFile, 'utf8').split(/\r?\n/);
    let inEvents = false;
    for (const line of lines) {
      if (line.trim().startsWith('[Events]')) { inEvents = true; continue; }
      if (!inEvents || !line.startsWith('Dialogue:')) continue;
      // Format: "Dialogue: 0,0:00:01.20,0:00:01.50,Default,,0,0,0,,text"
      const afterLayer = line.slice(line.indexOf(',') + 1);
      const parts = afterLayer.split(',');
      if (parts.length < 9) continue;
      const startSecs = parseAssTime(parts[0]) + offset;
      const endSecs   = parseAssTime(parts[1]) + offset;
      if (endSecs < 0) continue;
      parts[0] = formatAssTime(startSecs);
      parts[1] = formatAssTime(endSecs);
      dialogues.push(`Dialogue: 0,${parts.join(',')}`);
    }
  }
  dialogues.sort((a, b) => {
    const ta = parseAssTime(a.split(',')[1]);
    const tb = parseAssTime(b.split(',')[1]);
    return ta - tb;
  });
  return HEADER + dialogues.join('\n') + '\n';
}

const [,, segmentsFile, outputFile] = process.argv;
if (!segmentsFile || !outputFile) {
  console.error('Usage: node merge-captions.js <segments.json> <output.ass>');
  process.exit(1);
}
const segments = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));
const merged = mergeAss(segments);
fs.writeFileSync(outputFile, merged, 'utf8');
console.log(`Merged ${segments.length} ASS files → ${outputFile}`);
