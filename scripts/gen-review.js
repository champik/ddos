// gen-review.js <projectDir>
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node gen-review.js <projectDir>'); process.exit(1); }

const plan = JSON.parse(fs.readFileSync(path.join(projectDir, 'edit/episode-plan.json'), 'utf8'));
const editorial = (() => { try { return JSON.parse(fs.readFileSync(path.join(projectDir, 'edit/editorial.json'), 'utf8')); } catch { return {}; } })();
const thumbCount = (editorial.thumbnails || []).length;
const meta = JSON.parse(fs.readFileSync(path.join(projectDir, 'exports/metadata.json'), 'utf8'));
const scored = JSON.parse(fs.readFileSync(path.join(projectDir, 'clips/scored-clips.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(projectDir, 'state.json'), 'utf8'));

const ep = plan.episodeNumber || state.episodeNumber;
const runId = path.basename(projectDir);
const epPad = String(ep).padStart(3, '0');
const dateMatch = runId.match(/(\d{4})_(\d{2})_(\d{2})$/);
const dateStr = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : '—';
const isPublished = state.status === 'published' || state.stages?.publish === 'done';

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtViews(v) {
  if (v == null) return '—';
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}

function fmtDur(s) {
  if (s == null || s === 0) return '—';
  return Math.round(s) + 's';
}

function shortCat(name) {
  return (name || '?')
    .replace('Just Chatting', 'JC')
    .replace('Counter-Strike 2', 'CS2')
    .replace('Grand Theft Auto V', 'GTA V')
    .replace('World of Warcraft', 'WoW')
    .replace('Subnautica 2', 'Sub2');
}

function scoreColor(v) {
  if (v == null || v === '—') return '#f4f0e6';
  if (v >= 60) return '#00ff88';
  if (v >= 45) return '#f5ff3d';
  return '#f4f0e6';
}

function getCleanDuration(clipId) {
  // 1. Saved in score.json by trim-clips.js
  const scorePath = path.join(projectDir, 'processed', clipId, 'score.json');
  try {
    const sc = JSON.parse(fs.readFileSync(scorePath, 'utf8'));
    if (sc.trimmedDuration) return sc.trimmedDuration;
  } catch {}
  // 2. Fallback: ffprobe on clean.mp4 if still exists
  const cleanPath = path.join(projectDir, 'processed', clipId, 'clean.mp4');
  if (fs.existsSync(cleanPath)) {
    const r = spawnSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', cleanPath], { encoding: 'utf8' });
    const d = parseFloat(r.stdout);
    if (!isNaN(d)) return d;
  }
  return null;
}

function getHook(clipId) {
  try {
    return fs.readFileSync(path.join(projectDir, 'processed', clipId, 'hook.txt'), 'utf8').trim();
  } catch { return ''; }
}

const COLS = 11;
const RECONNECT_ROW = `  <tr class="reconnect-row"><td colspan="${COLS}">⟳ reconnect</td></tr>`;

function makeClipRow(id, num) {
  const s = scored.find(x => x.id === id) || {};
  let score = {};
  try { score = JSON.parse(fs.readFileSync(path.join(projectDir, 'processed', id, 'score.json'), 'utf8')); } catch {}

  const views = fmtViews(s.view_count);
  const twitchUrl = s.url || `https://clips.twitch.tv/${id}`;
  const flags = (score.flags || []).join(', ') || '';
  const ddos = score.ddosScore != null ? score.ddosScore : '—';
  const viral = score.viralityScore != null ? score.viralityScore : '—';
  const funny = score.funnyScore != null ? score.funnyScore : '—';
  const shorts = score.shortsPotential != null ? score.shortsPotential : '—';
  const inShorts = plan.shortClipIds.includes(id) ? ' <span style="color:#f5ff3d">★</span>' : '';
  const reasoning = esc(score.reasoning || '');

  const origDur = s.duration || score.duration;
  const cleanDur = getCleanDuration(id);
  const durStr = cleanDur != null
    ? `${fmtDur(cleanDur)}<span style="color:#555">/${fmtDur(origDur)}</span>`
    : fmtDur(origDur);

  const hook = getHook(id);
  const hookLine = hook ? `<div style="font-size:10px;font-weight:700;letter-spacing:1px;color:#f4f0e6;text-transform:uppercase;margin-bottom:3px">${esc(hook)}</div>` : '';
  const reasoningLine = reasoning ? `<div style="font-size:11px;color:#666;font-style:italic;margin-bottom:2px">${reasoning}</div>` : '';
  const flagsLine = flags ? `<div style="font-size:11px;color:#ff6b6b;font-weight:600">${esc(flags)}</div>` : '';

  return `  <tr>
    <td>${num}</td>
    <td><a href="${esc(twitchUrl)}" target="_blank">${esc(s.broadcaster_name || '?')}</a></td>
    <td>${esc(shortCat(s.game_name))}</td>
    <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title || '—')}</td>
    <td style="white-space:nowrap;font-family:'JetBrains Mono',monospace;font-size:11px">${durStr}</td>
    <td style="font-weight:600;color:${scoreColor(ddos)}">${ddos}</td>
    <td style="color:#888">${viral}</td>
    <td>${funny}</td>
    <td>${shorts}${inShorts}</td>
    <td>${views}</td>
    <td style="min-width:200px;max-width:300px">${hookLine}${reasoningLine}${flagsLine}</td>
  </tr>`;
}

const rowParts = [];
let clipNum = 0;
for (let gi = 0; gi < plan.groups.length; gi++) {
  const group = plan.groups[gi];
  for (const id of group.clipIds) {
    clipNum++;
    rowParts.push(makeClipRow(id, clipNum));
  }
  const isLast = gi === plan.groups.length - 1;
  if (!isLast && !group.noTrailingReconnect) {
    rowParts.push(RECONNECT_ROW);
  }
}
const rows = rowParts.join('\n');

const selectedTitle = meta.selectedTitle || null;
const titleOptionsArr = Array.isArray(meta.titleOptions)
  ? meta.titleOptions
  : Object.values(meta.titleOptions || {});
const titleCards = selectedTitle
  ? `  <div class="title-card title-card--selected"><span class="title-num">✓</span><span>${esc(selectedTitle)}</span></div>`
  : titleOptionsArr.map((t, i) =>
      `  <div class="title-card"><span class="title-num">${i + 1}</span><span>${esc(t)}</span></div>`
    ).join('\n');
const selectedTitleHtml = '';

const shortsGrid = (meta.shortsMetadata || []).map(sm =>
  `  <div class="short-card">
    <video src="../exports/shorts/${sm.clipId}.mp4" controls></video>
    <div class="short-title">${esc(sm.title)}</div>
    <div class="short-description">${esc(sm.description || '')}</div>
  </div>`
).join('\n');

const descEscaped = esc(meta.description);
const tagsStr = esc(meta.tags.join(' · '));
const shortsCount = (meta.shortsMetadata || []).length;

const youtubeVideoId = state.outputs?.youtubeVideoId;
const youtubeShortsIds = (state.outputs?.youtubeShortsIds || []).map(x => typeof x === 'string' ? x : x.shortId).filter(Boolean);
const approveBox = isPublished
  ? ''
  : `<div class="approve-box">
  <p>Перевір все вище. Коли готово — виконай команду:</p>
  <code>/ddos approve ${runId}</code>
</div>`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DDOS EP #${ep} Review</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Space+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { background: #0e0e10; color: #f4f0e6; font-family: 'Space Grotesk', sans-serif; margin: 0; padding: 32px 24px; }
  .container { max-width: 1200px; margin: 0 auto; }
  h2 { font-family: 'Anton', sans-serif; color: #f5ff3d; letter-spacing: 2px; font-size: 22px; margin: 0 0 16px; }
  .subtitle { color: #666; font-size: 13px; font-family: 'JetBrains Mono', monospace; margin-bottom: 40px; }
  .status-ok { color: #00ff88; font-weight: 600; }
  .section { margin-bottom: 48px; border-top: 1px solid #1e1e22; padding-top: 32px; }
  .section:first-of-type { border-top: none; }
  .video-wrap { background: #000; border-radius: 10px; overflow: hidden; display: inline-block; max-width: 100%; }
  .video-wrap video { display: block; width: 100%; max-width: 960px; height: auto; }
  .thumb-wrap img { max-width: 640px; width: 100%; border-radius: 10px; border: 2px solid #222; display: block; }
  .title-cards { display: flex; flex-direction: column; gap: 10px; max-width: 800px; }
  .title-card { background: #1a1a1e; padding: 14px 18px; border-radius: 8px; border: 2px solid #2a2a2e; cursor: pointer; display: flex; align-items: center; gap: 14px; transition: border-color 0.15s; }
  .title-card:hover { border-color: #f5ff3d; }
  .title-card--selected { border-color: #f5ff3d; background: #1a2a0a; }
  .title-num { font-family: 'Anton', sans-serif; color: #f5ff3d; font-size: 20px; min-width: 20px; }
  .table-wrap { overflow-x: auto; border-radius: 8px; border: 1px solid #222; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th { background: #1a1a1e; color: #f5ff3d; font-family: 'JetBrains Mono', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 12px; border-bottom: 1px solid #333; text-align: left; white-space: nowrap; }
  tbody td { padding: 8px 12px; border-bottom: 1px solid #1a1a1e; vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: #141416; }
  td a { color: #f5ff3d; text-decoration: none; font-weight: 500; }
  td a:hover { text-decoration: underline; }
  td:nth-child(3) { color: #888; font-size: 11px; }
  .shorts-grid { display: flex; flex-wrap: wrap; gap: 20px; }
  .short-card { display: flex; flex-direction: column; gap: 8px; }
  .short-card video { width: 155px; border-radius: 8px; background: #000; aspect-ratio: 9 / 16; }
  .short-title { font-size: 11px; font-weight: 600; color: #f5ff3d; max-width: 155px; line-height: 1.3; }
  .short-description { font-size: 10px; color: #888; max-width: 155px; line-height: 1.4; }
  .meta-block { background: #1a1a1e; border-radius: 10px; padding: 20px 24px; }
  .meta-desc { font-family: 'JetBrains Mono', monospace; font-size: 12px; line-height: 1.8; white-space: pre-wrap; color: #f4f0e6; margin: 0 0 16px; }
  .meta-tags { font-size: 11px; color: #555; line-height: 1.8; }
  .reconnect-row td { background: #111113; color: #383838; font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: 1px; text-align: center; padding: 5px; border-bottom: 1px solid #1e1e22; }

  .approve-box { background: #1a1a1e; padding: 24px; border-radius: 10px; border: 1px solid #333; margin-top: 48px; }
  .approve-box p { margin: 0 0 10px; color: #888; font-size: 14px; }
  code { color: #f5ff3d; font-family: 'JetBrains Mono', monospace; font-size: 15px; font-weight: 600; }
  .published-box { border-color: #1a3a2a; }
  .published-status { font-family: 'Anton', sans-serif; font-size: 22px; color: #4ade80; letter-spacing: 2px; margin-bottom: 14px; }
  .links-row { display: flex; gap: 8px; flex-wrap: wrap; }
  a.btn { display: inline-flex; align-items: center; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; text-decoration: none; transition: opacity 0.15s; }
  a.btn:hover { opacity: 0.8; }
  .btn-youtube { background: #ff0000; color: #fff; }
  .btn-shorts  { background: #333; color: #f4f0e6; border: 1px solid #444; }
</style>
</head>
<body>
<div class="container">

<div style="display:flex;align-items:center;gap:16px;margin-bottom:4px">
  <a href="../../index.html" style="display:inline-block;text-decoration:none;flex-shrink:0">
    <img src="../../../assets/thumbnail-template/logo.svg" alt="DDOS" style="height:56px;display:block">
  </a>
  <div style="font-family:'Anton',sans-serif;font-size:52px;color:#f5ff3d;letter-spacing:3px;line-height:1">EPISODE #${ep}</div>
</div>
<div class="subtitle">${runId} &nbsp;·&nbsp; ${dateStr} &nbsp;·&nbsp; <span class="status-ok">${isPublished ? '✓ Published' : '✓ Ready for review'}</span> &nbsp;·&nbsp; ${plan.clipOrder.length} clips</div>
${isPublished && (youtubeVideoId || youtubeShortsIds.length) ? `<div class="links-row" style="margin-bottom:32px">
  ${youtubeVideoId ? `<a class="btn btn-youtube" href="https://youtu.be/${youtubeVideoId}" target="_blank">YouTube ↗</a>` : ''}
  ${youtubeShortsIds.map((id, i) => `<a class="btn btn-shorts" href="https://youtube.com/shorts/${id}" target="_blank">Short ${i + 1} ↗</a>`).join('\n  ')}
</div>` : ''}

<div class="section">
<h2>Long-form</h2>
<div class="video-wrap">
  <video src="../exports/episode-${epPad}.mp4" controls></video>
</div>
</div>

<div class="section">
<h2>Thumbnail</h2>
<div style="display:grid;grid-template-columns:repeat(${thumbCount >= 2 ? 3 : 2},1fr);gap:12px">
  <div>
    <div style="font-size:11px;color:#888;margin-bottom:6px;font-family:monospace">V1 — Original (Puppeteer)</div>
    <img src="../exports/thumbnail.png" alt="V1" style="width:100%;border-radius:6px">
  </div>
  <div>
    <div style="font-size:11px;color:#888;margin-bottom:6px;font-family:monospace">V2 — Emotion Enhanced (Higgsfield)</div>
    <img src="../exports/thumbnail-v2.png" alt="V2" style="width:100%;border-radius:6px" onerror="this.style.opacity='.2';this.alt='not generated'">
  </div>
  ${thumbCount >= 2 ? `<div>
    <div style="font-size:11px;color:#888;margin-bottom:6px;font-family:monospace">V3 — Composite Scene (Higgsfield)</div>
    <img src="../exports/thumbnail-v3.png" alt="V3" style="width:100%;border-radius:6px" onerror="this.style.opacity='.2';this.alt='not generated'">
  </div>` : ''}
</div>
</div>

<div class="section">
<h2>Title Options</h2>
${selectedTitleHtml}
<div class="title-cards">
${titleCards}
</div>
</div>

<div class="section">
<h2>Clips (${plan.clipOrder.length})</h2>
<div class="table-wrap">
<table>
<thead>
  <tr>
    <th>#</th><th>Streamer</th><th>Cat</th><th>Title</th><th>Dur</th>
    <th>DDOS</th><th>Viral</th><th>Funny</th><th>Shorts</th><th>Views</th><th>Hook / Reasoning / Flags</th>
  </tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</div>
</div>

<div class="section">
<h2>Shorts (${shortsCount})</h2>
<div class="shorts-grid">
${shortsGrid}
</div>
</div>

<div class="section">
<h2>Metadata</h2>
<div class="meta-block">
  <div class="meta-desc">${descEscaped}</div>
  <div class="meta-tags">Tags: ${tagsStr}</div>
</div>
</div>

${approveBox}

</div>
</body>
</html>`;

fs.mkdirSync(path.join(projectDir, 'review'), { recursive: true });
fs.writeFileSync(path.join(projectDir, 'review/review.html'), html);
console.log('✓ review.html ->', path.join(projectDir, 'review/review.html'));
