'use strict';
const fs   = require('fs');
const path = require('path');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node gen-review.js <projectDir>'); process.exit(1); }

require('./progress').step(projectDir, 15, 'Генерую review.html');

const state  = JSON.parse(fs.readFileSync(path.join(projectDir, 'state.json'), 'utf8'));
const plan   = JSON.parse(fs.readFileSync(path.join(projectDir, 'edit/episode-plan.json'), 'utf8'));
const meta   = JSON.parse(fs.readFileSync(path.join(projectDir, 'exports/metadata.json'), 'utf8'));
const scored = JSON.parse(fs.readFileSync(path.join(projectDir, 'clips/scored-clips.json'), 'utf8'));

const scoreMap = {};
for (const c of scored) scoreMap[c.id] = c;

const ep = String(state.episodeNumber).padStart(3, '0');
const runId = state.runId || path.basename(projectDir);

// Build clips table rows
let clipRows = '';
plan.clipOrder.forEach((id, i) => {
  const c = scoreMap[id] || {};
  const flags = (c.flags || []).join(', ') || '—';
  const musicWarn = (c.musicRisk || 0) > 60 ? '⚠️' : '';
  const cleanPath = path.relative(path.join(projectDir, 'review'), path.join(projectDir, 'processed', id, 'clean.mp4')).replace(/\\/g, '/');
  const ovPath    = path.relative(path.join(projectDir, 'review'), path.join(projectDir, 'processed', id, 'overlayed.mp4')).replace(/\\/g, '/');
  const hasOv = fs.existsSync(path.join(projectDir, 'processed', id, 'overlayed.mp4'));
  const videoLink = hasOv ? ovPath : cleanPath;
  const views = c.view_count ? (c.view_count >= 1000 ? (c.view_count/1000).toFixed(1)+'k' : String(c.view_count)) : '—';
  clipRows += `<tr>
    <td>${i+1}</td>
    <td><a href="${videoLink}" style="color:#f5ff3d;text-decoration:none" target="_blank">▶ ${c.broadcaster_name || '?'}</a></td>
    <td>${c.game_name || '?'}</td>
    <td style="max-width:220px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${c.title || id.slice(0,30)}</td>
    <td style="color:#f5ff3d;font-weight:700">${Math.round(c.ddosScore||0)}</td>
    <td>${Math.round(c.funnyScore||0)}</td>
    <td>${Math.round(c.shortsPotential||0)}</td>
    <td>${musicWarn}${Math.round(c.musicRisk||0)}</td>
    <td style="color:#aaa">${views}</td>
    <td style="font-size:11px;color:#aaa">${flags}</td>
  </tr>`;
});

// Shorts grid
const shortClipIds = plan.shortClipIds || [];
let shortsGrid = '';
for (const id of shortClipIds) {
  const c = scoreMap[id] || {};
  const exists = fs.existsSync(path.join(projectDir, 'exports/shorts', id + '.mp4'));
  if (!exists) continue;
  shortsGrid += `<div style="display:inline-block;margin:6px;vertical-align:top;text-align:center">
    <video src="../exports/shorts/${id}.mp4" controls width="180" style="border-radius:8px;display:block"></video>
    <div style="font-size:11px;margin-top:4px;color:#aaa;max-width:180px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">@${c.broadcaster_name||'?'}</div>
  </div>`;
}

// Title cards
let titleCards = '';
meta.titleOptions.forEach((t, i) => {
  titleCards += `<div style="background:#18181b;border:2px solid ${i===0?'#f5ff3d':'#333'};border-radius:8px;padding:14px 18px;margin-bottom:10px;cursor:pointer;font-size:15px" onclick="this.style.border='2px solid #f5ff3d'">
    <span style="color:#f5ff3d;font-weight:700;margin-right:10px">${i+1}</span>${t}
  </div>`;
});

const html = `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<title>DDOS Review · Episode #${state.episodeNumber}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Space+Grotesk:wght@400;600&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0e0e10; color: #f4f0e6; font-family: 'Space Grotesk', sans-serif; padding: 32px 24px; max-width: 1100px; margin: 0 auto; }
h1, h2 { font-family: 'Anton', sans-serif; letter-spacing: 1px; }
h1 { font-size: 42px; color: #f5ff3d; margin-bottom: 4px; }
h2 { font-size: 22px; color: #f5ff3d; margin: 32px 0 14px; }
.meta { color: #888; font-size: 13px; margin-bottom: 28px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { background: #18181b; color: #f5ff3d; text-align: left; padding: 8px 10px; }
td { padding: 7px 10px; border-bottom: 1px solid #1f1f23; }
tr:hover td { background: #18181b; }
code { font-family: 'JetBrains Mono', monospace; font-size: 14px; }
.desc { background: #111113; padding: 14px 18px; border-radius: 8px; white-space: pre-wrap; font-size: 13px; line-height: 1.7; color: #ccc; }
</style>
</head>
<body>

<h1>DDOS · EPISODE #${state.episodeNumber}</h1>
<div class="meta">Run: ${runId} · ${new Date().toISOString().slice(0,10)} · <span style="color:#4ade80">✓ Ready for review</span></div>

<h2>Long-form</h2>
<video src="../exports/episode-${ep}.mp4" controls width="960" style="border-radius:8px;max-width:100%"></video>

<h2>Thumbnail</h2>
<img src="../exports/thumbnail.png" style="max-width:640px;border-radius:8px;display:block">

<h2>Title Options</h2>
${titleCards}

<h2>Clips (${plan.clipOrder.length})</h2>
<table>
  <thead><tr><th>#</th><th>Стрімер ▶</th><th>Категорія</th><th>Назва</th><th>DDOS</th><th>Funny</th><th>Shorts</th><th>Music</th><th>Views</th><th>Flags</th></tr></thead>
  <tbody>${clipRows}</tbody>
</table>

<h2>Shorts (${shortClipIds.length})</h2>
<div>${shortsGrid || '<p style="color:#888">No shorts rendered</p>'}</div>

<h2>Description & Tags</h2>
<div class="desc">${meta.description.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>

<h2>Approve</h2>
<div style="background:#1a1a1e;padding:20px;border-radius:8px;margin-top:8px">
  <p style="margin-bottom:12px">Перевір все вище. Коли готово — виконай команду:</p>
  <code style="color:#f5ff3d">/ddos approve ${runId}</code>
</div>

</body>
</html>`;

fs.mkdirSync(path.join(projectDir, 'review'), { recursive: true });
fs.writeFileSync(path.join(projectDir, 'review/review.html'), html, 'utf8');
console.log('\n✓ Review page готова');
console.log('Відкрий: ' + path.join(projectDir, 'review/review.html'));
