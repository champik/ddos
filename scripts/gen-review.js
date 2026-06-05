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


function getCleanDuration(clipId) {
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

const COLS = 8;
const RECONNECT_ROW = `  <tr class="reconnect-row"><td colspan="${COLS}">⟳ reconnect</td></tr>`;

function fmtVelocity(clip) {
  if (!clip.view_count || !clip.created_at) return '—';
  const hours = Math.max((Date.now() - new Date(clip.created_at)) / 3600000, 0.5);
  const avgViewers = clip.avg_viewers || 1000;
  const normalized = clip.view_count / hours / avgViewers;
  return normalized.toFixed(2) + 'x';
}

function makeClipRow(id, num) {
  const s = scored.find(x => x.id === id) || {};
  const twitchUrl = s.url || `https://clips.twitch.tv/${id}`;
  const views = fmtViews(s.view_count);
  const vel = fmtVelocity(s);

  const origDur = s.duration;
  const cleanDur = getCleanDuration(id);
  const durStr = cleanDur != null
    ? `${fmtDur(cleanDur)}<span style="color:#555">/${fmtDur(origDur)}</span>`
    : fmtDur(origDur);

  // Tags cell
  const edClip = (editorial.clips || {})[id] || {};
  const tags = [];
  if ((plan.shortClipIds || []).includes(id)) {
    const mode = edClip.short?.mode || 'desktop';
    tags.push(`<span style="color:#a78bfa;font-size:10px;font-weight:700">SHORT:${mode.toUpperCase()}</span>`);
  }
  const isThumb = (editorial.thumbnails || []).some(t => t.clipId === id);
  if (isThumb) tags.push(`<span style="color:#4ade80;font-size:10px;font-weight:700">THUMB</span>`);
  const cuts = (edClip.keeps || []).length;
  if (cuts > 0) tags.push(`<span style="color:#f5ff3d;font-size:10px;font-family:monospace">✂${cuts}</span>`);
  const tagsStr = tags.join(' ') || '—';

  return `  <tr>
    <td>${num}</td>
    <td><a href="${esc(twitchUrl)}" target="_blank">${esc(s.broadcaster_name || '?')}</a></td>
    <td>${esc(shortCat(s.game_name))}</td>
    <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title || '—')}</td>
    <td style="white-space:nowrap;font-family:'JetBrains Mono',monospace;font-size:11px">${durStr}</td>
    <td>${views}</td>
    <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#888">${vel}</td>
    <td style="white-space:nowrap">${tagsStr}</td>
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

const titleOptionsArr = Array.isArray(meta.titleOptions)
  ? meta.titleOptions
  : Object.values(meta.titleOptions || {});
const pipeCaptions = meta.thumbnailCaptions || [];
const allTitles = [
  ...titleOptionsArr.map((t, i) => ({ label: String(i + 1), text: t, style: '' })),
  ...pipeCaptions.map((t, i) => ({ label: String.fromCharCode(65 + i), text: t, style: 'color:#aaa' }))
];
const selectedTitle = meta.selectedTitle || '';
const titleCards = allTitles.map((item, i) => {
  const isSelected = isPublished && selectedTitle && item.text === selectedTitle;
  const cls = isSelected ? ' title-selected' : '';
  return `  <div class="title-card${cls}" onclick="selectTitle(this, TITLES[${i}])">`+
    `<span class="title-num" style="${item.style}">${item.label}</span>`+
    `<span>${esc(item.text)}</span>`+
    (isSelected ? `<span style="margin-left:auto;color:#f5ff3d;font-size:13px">✓</span>` : '')+
    `</div>`;
}).join('\n');

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
  <p>⚠️ <strong>Клікни на заголовок вище</strong>, потім скопіюй команду:</p>
  <div id="selected-title-preview" style="display:none;background:#1a2a0a;border:2px solid #f5ff3d;border-radius:8px;padding:12px 16px;margin-bottom:12px">
    <div style="font-size:10px;color:#888;font-family:'JetBrains Mono',monospace;letter-spacing:1px;margin-bottom:4px">ВИБРАНИЙ ЗАГОЛОВОК:</div>
    <div id="selected-title-text" style="font-size:15px;font-weight:700;color:#f5ff3d;line-height:1.4"></div>
  </div>
  <pre id="approve-cmd" style="background:#111;color:#888;font-family:'JetBrains Mono',monospace;font-size:13px;padding:14px 16px;border-radius:8px;white-space:pre-wrap;word-break:break-all;margin:0 0 12px">← спочатку вибери заголовок вище</pre>
  <button onclick="copyApprove()" style="background:#555;color:#999;border:none;border-radius:8px;padding:10px 20px;font-weight:700;font-size:13px;cursor:not-allowed" id="approve-btn" disabled>📋 Copy</button>
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
  .title-card:hover { border-color: #f5ff3d55; }
  .title-card.title-selected { border-color: #f5ff3d; background: #1a2a0a; }
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
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
${[
  { id: 'v1', label: 'V1 — Puppeteer', src: fs.existsSync(path.join(projectDir, 'exports/thumbnail-v1.png')) ? '../exports/thumbnail-v1.png' : '../exports/thumbnail.png' },
  { id: 'v2', label: 'V2 — Higgsfield emotion', src: '../exports/thumbnail-v2.png' },
  { id: 'v3', label: 'V3 — Higgsfield composite', src: '../exports/thumbnail-v3.png' },
].map(t => {
  const sel = isPublished
    ? (meta.selectedThumbnail === t.id)
    : (t.id === 'v1');
  const border = sel ? '#f5ff3d' : '#2a2a2e';
  const badge = sel && isPublished ? `<span style="color:#f5ff3d;margin-left:6px">✓</span>` : '';
  const err = t.id !== 'v1' ? ` onerror="this.parentElement.style.opacity='.4'"` : '';
  return `  <div class="thumb-option${sel ? ' thumb-selected' : ''}" onclick="selectThumb(this,'${t.id}')" style="cursor:pointer;border-radius:8px;border:2px solid ${border};padding:8px">
    <div style="font-size:11px;color:#888;margin-bottom:6px;font-family:monospace;display:flex;align-items:center">${t.label}${badge}</div>
    <img src="${t.src}" alt="${t.id.toUpperCase()}" style="width:100%;border-radius:4px"${err}>
  </div>`;
}).join('\n')}
</div>
</div>

<div class="section">
<h2>Title Options</h2>
<div style="font-size:11px;color:#555;font-family:monospace;margin-bottom:12px">1-5 = curiosity/specific/emotion/direct/unexpected &nbsp;·&nbsp; A-C = pipe style</div>
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
    <th>Views</th><th>Vel/hr</th><th>Tags</th>
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
<script>
const RUN_ID = ${JSON.stringify(runId)};
const TITLES = ${JSON.stringify(allTitles.map(t => t.text))};
let _title = null;
let _thumb = 'v1';

function updateCmd() {
  const el = document.getElementById('approve-cmd');
  const btn = document.getElementById('approve-btn');
  const preview = document.getElementById('selected-title-preview');
  const previewText = document.getElementById('selected-title-text');
  if (!el) return;
  if (!_title) {
    el.style.color = '#888';
    el.textContent = '← спочатку вибери заголовок вище';
    if (btn) { btn.disabled = true; btn.style.background = '#555'; btn.style.color = '#999'; btn.style.cursor = 'not-allowed'; }
    if (preview) preview.style.display = 'none';
    return;
  }
  el.style.color = '#f5ff3d';
  el.textContent = '/approve\\n\\n' + JSON.stringify({ runId: RUN_ID, title: _title, thumbnail: _thumb }, null, 2);
  if (btn) { btn.disabled = false; btn.style.background = '#f5ff3d'; btn.style.color = '#0e0e10'; btn.style.cursor = 'pointer'; }
  if (preview) preview.style.display = 'block';
  if (previewText) previewText.textContent = _title;
}

function selectTitle(el, text) {
  _title = text;
  document.querySelectorAll('.title-card').forEach(c => c.classList.remove('title-selected'));
  el.classList.add('title-selected');
  updateCmd();
}

function selectThumb(el, variant) {
  _thumb = variant;
  document.querySelectorAll('.thumb-option').forEach(c => {
    c.style.borderColor = '#2a2a2e';
    c.classList.remove('thumb-selected');
  });
  el.style.borderColor = '#f5ff3d';
  el.classList.add('thumb-selected');
  updateCmd();
}

function copyApprove() {
  const text = document.getElementById('approve-cmd').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('approve-btn');
    btn.textContent = '✓ Copied';
    btn.style.background = '#f5ff3d';
    btn.style.color = '#0e0e10';
    btn.style.cursor = 'default';
    setTimeout(() => {
      btn.textContent = '📋 Copy';
      btn.style.background = '#f5ff3d';
      btn.style.color = '#0e0e10';
      btn.style.cursor = 'pointer';
    }, 2000);
  });
}
</script>
</body>
</html>`;

fs.mkdirSync(path.join(projectDir, 'review'), { recursive: true });
fs.writeFileSync(path.join(projectDir, 'review/review.html'), html);
console.log('✓ review.html ->', path.join(projectDir, 'review/review.html'));
