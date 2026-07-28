'use strict';
// render-shorts.js — 1080x1920 shorts: blur bg + bottom captions
// Uses clean.mp4 (no streamer banner). Clips rendered in parallel (CONCURRENCY = 3).
// Usage: node scripts/render-shorts.js <projectDir>

const fs   = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { readJson, updateState, stageStatus } = require('./lib/state');
const { analyzeRms, findPeak } = require('./lib/audio-peaks');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node render-shorts.js <projectDir> [--clip <id>] [--out-dir <dir>]'); process.exit(1); }
const clipArg    = (() => { const i = process.argv.indexOf('--clip');    return i !== -1 ? process.argv[i + 1] : null; })();
const outDirArg  = (() => { const i = process.argv.indexOf('--out-dir'); return i !== -1 ? process.argv[i + 1] : null; })();

require('./progress').step(projectDir, 13, 'Рендер шортсів');

const CONCURRENCY = 3;

function ffmpegPath(p) {
  const m = p.match(/^([A-Za-z]):(.*)/);
  if (!m) return p.replace(/\\/g, '/');
  return m[1] + '\\\\:' + m[2].replace(/\\/g, '/');
}

function fontPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

const FONT_FILE = path.relative(process.cwd(), path.join(__dirname, '../assets/fonts/impact.ttf')).replace(/\\/g, '/');

function escapeDrawtextText(s) {
  return (s || '')
    .slice(0, 40)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '’')
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

// Auto-scale font to fit within maxWidth with 50px margins on each side
function calcFontSize(text, maxWidth = 980, maxSize = 72, minSize = 28) {
  const chars = ((text || '').slice(0, 40)).length || 1;
  return Math.max(minSize, Math.min(maxSize, Math.floor(maxWidth / (chars * 0.60))));
}

function wrapText(text, maxChars = 28) {
  if (!text || text.length <= maxChars) return [text || ''];
  const mid = Math.floor(text.length / 2);
  for (let d = 0; d <= 15; d++) {
    if (mid - d > 0 && text[mid - d] === ' ') return [text.slice(0, mid - d).trim(), text.slice(mid - d).trim()];
    if (mid + d < text.length - 1 && text[mid + d] === ' ') return [text.slice(0, mid + d).trim(), text.slice(mid + d).trim()];
  }
  return [text];
}

function parseAssTime(t) {
  const [h, m, s] = t.split(':');
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
}

function trimAss(assPath, maxSec) {
  return fs.readFileSync(assPath, 'utf8').split('\n').filter(line => {
    if (!line.startsWith('Dialogue:')) return true;
    const cols = line.split(',');
    if (cols.length < 3) return true;
    return parseAssTime(cols[2].trim()) <= maxSec;
  }).join('\n');
}

// Old outro (CTA + arrows) — commented out, kept for reference if needed:
// function buildIntroOutroFilters(clipDur, introText, arrowInputIdx) { ... }

// Intro (scroll-stopping hook) renders whenever introText is available.
function buildIntroFilters(introText) {
  const ts      = `fontcolor=0xf5ff3d:bordercolor=black:borderw=3`;
  const lines   = wrapText(introText);
  const fontSize = Math.round(calcFontSize(lines[0], 920, 68, 36));
  const lineH   = Math.round(fontSize * 1.35);
  const alphaIn = `min(1,max(0,(5-t)/0.5))`;

  if (lines.length === 1) {
    return [`[pre_out]drawtext=fontfile=${FONT_FILE}:text='${escapeDrawtextText(lines[0])}':fontsize=${fontSize}:${ts}:x=(W-tw)/2:y=H/8-th/2+10:alpha='${alphaIn}'[out]`];
  }
  const y0 = Math.round(1920 / 8 - lineH) + 10;
  const y1 = Math.round(1920 / 8) + 10;
  return [
    `[pre_out]drawtext=fontfile=${FONT_FILE}:text='${escapeDrawtextText(lines[0])}':fontsize=${fontSize}:${ts}:x=(W-tw)/2:y=${y0}:alpha='${alphaIn}'[v_intro_l1]`,
    `[v_intro_l1]drawtext=fontfile=${FONT_FILE}:text='${escapeDrawtextText(lines[1])}':fontsize=${fontSize}:${ts}:x=(W-tw)/2:y=${y1}:alpha='${alphaIn}'[out]`
  ];
}

const base      = path.resolve(projectDir);
const plan      = readJson(path.join(base, 'edit/episode-plan.json'));

// Read editorial.json for short crop data and shorts array
let editorialClips = {};
let editorialShortsArray = null;
try {
  const ed = readJson(path.join(base, 'edit/editorial.json'));
  editorialClips = ed.clips || {};
  if (ed.shorts && ed.shorts.length > 0) editorialShortsArray = ed.shorts;
} catch {}

// Read downloaded-clips for streamer name lookup (ranking panel)
let streamerByClipId = {};
try {
  const dl = readJson(path.join(base, 'clips/downloaded-clips.json'));
  dl.forEach(c => { streamerByClipId[c.id] = c.broadcaster_name || ''; });
} catch {}

// Labels for ranking shorts (from episode-plan.json, keyed by primaryId = clips[0])
const labelsByPrimaryId = {};
(plan.shorts || []).forEach(s => {
  if (s.type === 'ranking' && s.labels && s.clips?.[0]) {
    labelsByPrimaryId[s.clips[0]] = s.labels;
  }
});

// Build shortItems: array of { type, primaryId, clips, labels? } — one entry per output short
// New format: editorial.shorts array; old format: combineWith/combinedInto on clips
let shortItems;
if (editorialShortsArray) {
  shortItems = editorialShortsArray
    .filter(item => !clipArg || (item.type === 'solo' ? item.clipId === clipArg : item.clips?.[0] === clipArg))
    .map(item => item.type === 'solo'
      ? { type: 'solo', primaryId: item.clipId, clips: [item.clipId] }
      : { type: item.type, primaryId: item.clips[0], clips: item.clips, labels: labelsByPrimaryId[item.clips[0]] || null });
} else {
  // Old format: combineWith / combinedInto on clips
  const combinedIntoSet = new Set(
    Object.entries(editorialClips)
      .filter(([, c]) => c.short?.combinedInto)
      .map(([id]) => id)
  );
  shortItems = (plan.shortClipIds || [])
    .filter(id => !clipArg || id === clipArg)
    .filter(id => !combinedIntoSet.has(id))
    .map(id => {
      const cw = editorialClips[id]?.short?.combineWith;
      return cw?.length
        ? { type: 'merge', primaryId: id, clips: [id, ...cw] }
        : { type: 'solo', primaryId: id, clips: [id] };
    });
}

// % of source frame → pixels (assumes 1920×1080 source)
function px(pct, axis) { return Math.round(pct / 100 * (axis === 'w' ? 1920 : 1080)); }
function even(n) { return n % 2 === 0 ? n : n + 1; }

function getShort(clipId) { return editorialClips[clipId]?.short || null; }
function getNoSubs(clipId) { return editorialClips[clipId]?.short?.noSubs === true; }

// Auto punch-in: мʼякий zoom 6% на найгучнішому моменті кліпу (in 0.35s,
// hold ~1.4s, out 0.35s). Вимикається per-clip: editorial.clips[id].short.punchIn = false.
// Якщо аналіз звуку недоступний — повертає null і шорт рендериться без панчу.
function buildPunchFilter(input, short) {
  if (short?.punchIn === false) return null;
  const windows = analyzeRms(input);
  const peak = findPeak(windows, { skipStart: 1.0, skipEnd: 1.5 });
  if (!peak) return null;
  const p0 = peak.t.toFixed(2);
  const p1 = (peak.t + 1.75).toFixed(2);
  const z = `(1+0.06*(min(max((t-${p0})/0.35,0),1)-min(max((t-${p1})/0.35,0),1)))`;
  console.log(`  [PUNCH] peak at ${p0}s (${peak.rms.toFixed(1)} dB)`);
  return `crop=w='floor(iw/${z}/2)*2':h='floor(ih/${z}/2)*2':x='(iw-ow)/2':y='(ih-oh)/2'`;
}

const LOGO_OUT  = path.join(__dirname, '../assets/shorts-logo.png');

function generateShortsLogo() {
  if (fs.existsSync(LOGO_OUT)) return;
  const svgPath = path.join(__dirname, '../assets/thumbnail-template/logo.svg');
  const svg = fs.readFileSync(svgPath, 'utf8');
  const match = svg.match(/href="data:image\/png;base64,([^"]+)"/);
  if (!match) throw new Error('shorts-logo: no embedded PNG in logo.svg');
  const buf = Buffer.from(match[1], 'base64');
  const tmp = LOGO_OUT + '.tmp.png';
  fs.writeFileSync(tmp, buf);
  const r = spawnSync('ffmpeg', ['-y', '-i', tmp, '-vf', 'scale=120:120', LOGO_OUT],
    { encoding: 'utf8' });
  fs.unlinkSync(tmp);
  if (r.status !== 0) throw new Error('shorts-logo generation failed:\n' + r.stderr);
  console.log('[LOGO] shorts-logo.png generated');
}

function getClipDuration(filePath) {
  const r = spawnSync('ffprobe', [
    '-v', 'quiet',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ], { encoding: 'utf8' });
  const raw = r.stdout ? r.stdout.trim() : '';
  const dur = parseFloat(raw);
  if (isNaN(dur)) throw new Error(`ffprobe: could not get duration for ${filePath}`);
  return dur;
}

function ffmpegAsync(args) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: 'pipe', cwd: process.cwd() });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => resolve({ status: code, stderr }));
    proc.on('error', e => resolve({ status: -1, stderr: e.message }));
  });
}

// Render one clip as a vertical 1080×1920 segment (captions burned in, no intro/outro)
// maxCapSec: if set, trim captions to end at this timestamp (seconds within the segment)
async function renderSegmentVertical(clipId, tmpOut, maxCapSec = null) {
  const input = path.join(base, 'processed', clipId, 'clean.mp4');
  if (!fs.existsSync(input)) { console.error(`  [SEG] No input for ${clipId}`); return null; }

  const assFile = path.join(base, 'processed', clipId, 'captions-vertical.ass');
  const short = editorialClips[clipId]?.short;
  const hasAss = fs.existsSync(assFile);
  const useAss = hasAss && !short?.noSubs;
  const mode = short?.mode || 'desktop';
  const punchStep = buildPunchFilter(input, short);
  const punch = punchStep ? `${punchStep},` : '';

  let activeAssFile = assFile;
  let trimmedAssPath = null;
  if (useAss && maxCapSec !== null) {
    const trimmed = trimAss(assFile, maxCapSec);
    trimmedAssPath = assFile.replace('captions-vertical.ass', `_seg_cap_trim.ass`);
    fs.writeFileSync(trimmedAssPath, trimmed);
    activeAssFile = trimmedAssPath;
  }

  let filterParts;
  if (mode === 'mobile') {
    const c = short?.mobile || { x: 34.18, y: 0, w: 31.64, h: 100 };
    const cw = px(c.w,'w'), ch = px(c.h,'h'), cx = px(c.x,'w'), cy = px(c.y,'h');
    const cropStr = `crop=${cw}:${ch}:${cx}:${cy},${punch}scale=1080:1920`;
    filterParts = useAss
      ? [`[0:v]${cropStr},ass=${ffmpegPath(activeAssFile)}[out_sar]`]
      : [`[0:v]${cropStr}[out_sar]`];
  } else if (mode === 'split' && short?.split) {
    const sp = short.split;
    const ratio  = sp.ratio ?? 0.7;
    const GAME_H = even(Math.round(1920 * ratio));
    const CAM_H  = 1920 - GAME_H;
    const g  = sp.gameplay || { x: 0, y: 0, w: 100, h: 100 };
    const wc = sp.webcam   || { x: 2,  y: 2, w: 30,  h: 30  };
    const GW = px(g.w,'w'), GH = px(g.h,'h'), GX = px(g.x,'w'), GY = px(g.y,'h');
    const WW = px(wc.w,'w'), WH = px(wc.h,'h'), WX = px(wc.x,'w'), WY = px(wc.y,'h');
    const fc = [
      '[0:v]split=2[vsrc1][vsrc2]',
      `[vsrc1]crop=${WW}:${WH}:${WX}:${WY},scale=1080:${CAM_H}[cam]`,
      `[vsrc2]crop=${GW}:${GH}:${GX}:${GY},${punch}scale=1080:${GAME_H}[game]`,
      '[cam][game]vstack=inputs=2[stacked]',
    ];
    if (useAss) fc.push(`[stacked]ass=${ffmpegPath(activeAssFile)}[out_sar]`);
    else fc[fc.length - 1] = fc[fc.length - 1].replace('[stacked]', '[out_sar]');
    filterParts = fc;
  } else {
    const c = short?.desktop || { x: 0, y: 0, w: 100, h: 100 };
    const cropStep = c.w >= 99 ? '' : `crop=${px(c.w,'w')}:${px(c.h,'h')}:${px(c.x,'w')}:${px(c.y,'h')},`;
    const blurFilters = [
      `[0:v]${cropStep}split[main][bg]`,
      '[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5,eq=brightness=-0.3[blurred]',
      `[main]${punch}scale=1080:-2[fg]`,
    ];
    filterParts = useAss
      ? [...blurFilters, `[blurred][fg]overlay=(W-w)/2:(H-h)/2,ass=${ffmpegPath(activeAssFile)}[out_sar]`]
      : [...blurFilters, '[blurred][fg]overlay=(W-w)/2:(H-h)/2[out_sar]'];
  }

  filterParts.push('[out_sar]setsar=1[out]');

  const dur = getClipDuration(input);
  // Аудіо не фільтрується — copy з clean.mp4 (AAC 192k/48kHz вже уніфікований)
  const r = await ffmpegAsync([
    '-i', input,
    '-filter_complex', filterParts.join(';'),
    '-map', '[out]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-c:a', 'copy',
    '-y', tmpOut
  ]);

  if (trimmedAssPath && fs.existsSync(trimmedAssPath)) fs.unlinkSync(trimmedAssPath);

  if (r.status !== 0) {
    const errLines = (r.stderr || '').split('\n').filter(l => /error/i.test(l));
    console.error(`  [SEG:FAIL] ${clipId}`, (errLines.length ? errLines : (r.stderr || '').split('\n').slice(-5)).slice(0,3).join('\n'));
    return null;
  }
  console.log(`  [SEG] ${clipId.slice(0, 28)} (${dur.toFixed(1)}s)`);
  return dur;
}

// Render a combined short from multiple clips — concat segments, then apply intro/outro
async function renderCombinedShort(primaryId, allClipIds, outPath, introText) {
  const tmpDir = path.join(base, 'processed', primaryId);
  const tmpFiles = [];

  for (let si = 0; si < allClipIds.length; si++) {
    const cid = allClipIds[si];
    const tmpOut = path.join(tmpDir, `_seg_${cid.slice(-12)}.mp4`);
    const dur = await renderSegmentVertical(cid, tmpOut, null);
    if (dur === null) {
      tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
      return false;
    }
    tmpFiles.push(tmpOut);
  }

  // Concat segments via concat demuxer. Сегменти вже в ідентичному форматі —
  // -c copy, без зайвого покоління перекодування. Без intro concat пише одразу
  // фінальний файл; з intro — єдине перекодування накладає текст.
  const concatListPath = path.join(tmpDir, '_combined_concat.txt');
  fs.writeFileSync(concatListPath, tmpFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
  const concatTmpPath = path.join(tmpDir, '_combined_tmp.mp4');

  const rConcat = await ffmpegAsync(introText
    ? ['-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', '-y', concatTmpPath]
    : ['-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', '-movflags', '+faststart', '-y', outPath]);

  tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  try { fs.unlinkSync(concatListPath); } catch {}

  if (rConcat.status !== 0) {
    console.error(`[COMBINED:CONCAT] FAIL`, (rConcat.stderr || '').split('\n').slice(-5).join('\n'));
    return false;
  }

  if (!introText) return true;

  // Apply intro on concatenated output (outro removed — one file for all platforms)
  const introFilterStr = ['[0:v]setsar=1[pre_out]', ...buildIntroFilters(introText)].join(';');

  const rFinal = await ffmpegAsync([
    '-i', concatTmpPath,
    '-filter_complex', introFilterStr,
    '-map', '[out]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-y', outPath
  ]);

  try { fs.unlinkSync(concatTmpPath); } catch {}

  if (rFinal.status !== 0) {
    console.error(`[COMBINED:FINAL] FAIL`, (rFinal.stderr || '').split('\n').slice(-5).join('\n'));
    return false;
  }
  return true;
}

const outDir = outDirArg ? path.resolve(outDirArg) : path.join(base, 'exports/shorts');
fs.mkdirSync(outDir, { recursive: true });

// Build id→hook and id→introText maps from metadata.json
let clipTitleMap = {};
let introTextMap = {};
try {
  const meta = readJson(path.join(base, 'exports/metadata.json'));
  (meta.clipHooks   || []).forEach(h => { clipTitleMap[h.clipId] = h.hook      || ''; });
  (meta.shortIntros || []).forEach(h => { introTextMap[h.clipId] = h.introText || ''; });
} catch {}

async function processClip(clipId) {
  const input = path.join(base, 'processed', clipId, 'clean.mp4');
  const assFile = path.join(base, 'processed', clipId, 'captions-vertical.ass');
  const output  = path.join(outDir, `${clipId}.mp4`);

  if (!fs.existsSync(input)) {
    console.log(`[SKIP] No clean.mp4: ${clipId}`);
    return false;
  }

  const hasAss = fs.existsSync(assFile);
  const clipDur   = getClipDuration(input);
  const introText = introTextMap[clipId] || '';
  const short  = getShort(clipId);
  const mode   = short?.mode || 'desktop';
  const noSubs = getNoSubs(clipId);
  const useAss = hasAss && !noSubs;
  console.log(`[SHORT:${mode.toUpperCase()}] ${clipId.slice(0, 28)}${useAss ? ' +captions' : ''}`);

  // Combined short: concat multiple clips into one
  if (short?.combineWith?.length) {
    console.log(`[SHORT:COMBINED] ${clipId.slice(0, 28)} + ${short.combineWith.length} more`);
    const success = await renderCombinedShort(clipId, [clipId, ...short.combineWith], output, introText);
    if (success) console.log(`[OK] ${clipId.slice(0, 32)} (combined)`);
    else console.error(`[FAIL] ${clipId} (combined)`);
    return success;
  }

  const punchStep = buildPunchFilter(input, short);
  const punch = punchStep ? `${punchStep},` : '';

  // Captions run to end of clip (outro removed — no need to trim for CTA space)
  // const trimmedAssPath = null; // kept for reference if outro is re-enabled
  const activeAssFile = assFile;

  const ffInputs = ['-i', input];
  let filterParts;

  if (mode === 'mobile') {
    const c = short?.mobile || { x: 34.18, y: 0, w: 31.64, h: 100 };
    const cw = px(c.w, 'w'), ch = px(c.h, 'h'), cx = px(c.x, 'w'), cy = px(c.y, 'h');
    const cropFilter = `crop=${cw}:${ch}:${cx}:${cy},${punch}scale=1080:1920`;
    filterParts = useAss
      ? [`[0:v]${cropFilter},ass=${ffmpegPath(activeAssFile)}[out]`]
      : [`[0:v]${cropFilter}[out]`];

  } else if (mode === 'split' && short?.split) {
    const sp = short.split;
    const ratio   = sp.ratio ?? 0.7;
    const GAME_H  = even(Math.round(1920 * ratio));
    const CAM_H   = 1920 - GAME_H;
    const g  = sp.gameplay || { x: 0, y: 0, w: 100, h: 100 };
    const wc = sp.webcam   || { x: 2,  y: 2, w: 30,  h: 30  };
    const GW = px(g.w,'w'), GH = px(g.h,'h'), GX = px(g.x,'w'), GY = px(g.y,'h');
    const WW = px(wc.w,'w'), WH = px(wc.h,'h'), WX = px(wc.x,'w'), WY = px(wc.y,'h');
    const fc = [
      '[0:v]split=2[vsrc1][vsrc2]',
      `[vsrc1]crop=${WW}:${WH}:${WX}:${WY},scale=1080:${CAM_H}[cam]`,
      `[vsrc2]crop=${GW}:${GH}:${GX}:${GY},${punch}scale=1080:${GAME_H}[game]`,
      '[cam][game]vstack=inputs=2[stacked]'
    ];
    if (useAss) fc.push(`[stacked]ass=${ffmpegPath(activeAssFile)}[out]`);
    else fc[fc.length - 1] = fc[fc.length - 1].replace('[stacked]', '[out]');
    filterParts = fc;

  } else {
    const c = short?.desktop || { x: 0, y: 0, w: 100, h: 100 };
    const cropStep = c.w >= 99 ? '' :
      `crop=${px(c.w,'w')}:${px(c.h,'h')}:${px(c.x,'w')}:${px(c.y,'h')},`;
    const blurFilters = [
      `[0:v]${cropStep}split[main][bg]`,
      '[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5,eq=brightness=-0.3[blurred]',
      `[main]${punch}scale=1080:-2[fg]`
    ];
    filterParts = useAss
      ? [...blurFilters, `[blurred][fg]overlay=(W-w)/2:(H-h)/2,ass=${ffmpegPath(activeAssFile)}[out]`]
      : [...blurFilters, '[blurred][fg]overlay=(W-w)/2:(H-h)/2[out]'];
  }

  // Ensure SAR=1:1 so players don't add black bars from incorrect pixel AR
  filterParts[filterParts.length - 1] = filterParts[filterParts.length - 1].replace(/\[out\]$/, '[out_sar]');
  if (introText) {
    filterParts.push('[out_sar]setsar=1[pre_out]');
    filterParts.push(...buildIntroFilters(introText));
  } else {
    filterParts.push('[out_sar]setsar=1[out]');
  }

  const r = await ffmpegAsync([
    ...ffInputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[out]',
    '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-y', output
  ]);

  if (r.status === 0) {
    console.log(`[OK] ${clipId.slice(0, 32)}`);
    return true;
  } else {
    const lines = (r.stderr || '').split('\n');
    const errLines = lines.filter(l => /error/i.test(l));
    console.error(`[FAIL] ${clipId}`);
    console.error((errLines.length ? errLines.slice(0, 3) : lines.slice(-5)).join('\n'));
    return false;
  }
}

// Build FFmpeg drawtext+drawbox filters for the ranking panel overlay.
// clipStreamerNames: ordered [rank1_name, rank2_name, ..., rankN_name] (index 0 = best = #1).
// currentRevealRank: 1-indexed rank being revealed NOW (N=worst first reveal, 1=last reveal).
function buildRankingPanelFilters(N, currentRevealRank, clipStreamerNames, inputPad) {
  const ROW_H    = Math.min(52, Math.max(32, Math.floor(900 / Math.max(N, 1))));
  const PAN_H  = N * ROW_H;
  const PAN_Y  = Math.floor((1920 - PAN_H) / 2);
  const PAN_W  = 295;
  const NUM_FS = 36;
  const NICK_FS= 36;

  const parts = [];
  let pad = inputPad;

  for (let i = 0; i < N; i++) {
    const rank   = i + 1;
    const rowMidY= PAN_Y + i * ROW_H + Math.floor(ROW_H / 2);
    const numY   = rowMidY - Math.floor(NUM_FS * 0.55);
    const nickY  = rowMidY - Math.floor(NICK_FS * 0.55);

    const isCurrent  = rank === currentRevealRank;
    const isRevealed = rank > currentRevealRank; // already shown (worse ranks shown earlier)
    const isHidden   = rank < currentRevealRank; // not yet shown (better ranks)

    const numColor  = isCurrent ? '0xf5ff3d' : 'white';
    const nickColor = isCurrent ? '0xf5ff3d' : 'white';
    const bw        = isCurrent ? 3 : (isRevealed ? 2 : 0);

    const numLabel = `rk_n${i}`;
    parts.push(`${pad}drawtext=fontfile=${FONT_FILE}:text='\\#${rank}':fontsize=${NUM_FS}:fontcolor=${numColor}:bordercolor=black:borderw=${bw}:x=50:y=${numY}[${numLabel}]`);
    pad = `[${numLabel}]`;

    if (!isHidden) {
      const name = escapeDrawtextText(clipStreamerNames[i] || '');
      const nickLabel = `rk_k${i}`;
      parts.push(`${pad}drawtext=fontfile=${FONT_FILE}:text='${name}':fontsize=${NICK_FS}:fontcolor=${nickColor}:bordercolor=black:borderw=${bw}:x=100:y=${nickY}[${nickLabel}]`);
      pad = `[${nickLabel}]`;
    }
  }

  return { parts, lastPad: pad };
}

// Render ranking short: clips rendered worst→best, each with the ranking panel.
// rankingClips: [best_clipId, ..., worst_clipId] (index 0 = rank #1).
async function renderRankingShort(primaryId, rankingClips, outPath, introText, labels) {
  const N      = rankingClips.length;
  const tmpDir = path.join(base, 'processed', primaryId);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFiles = [];

  // Use custom labels if provided, otherwise fall back to streamer names
  const streamerNames = labels
    ? labels
    : rankingClips.map(id => streamerByClipId[id] || '');

  // Pre-probe durations for caption cutoff on last segment
  const segDurs = rankingClips.map(id => {
    const f = path.join(base, 'processed', id, 'clean.mp4');
    return fs.existsSync(f) ? getClipDuration(f) : 0;
  });

  // Render segments in reverse order: worst (clips[N-1]) first, best (clips[0]) last
  for (let k = 0; k < N; k++) {
    const arrayIdx       = N - 1 - k;    // clips[N-1] first, clips[0] last
    const clipId         = rankingClips[arrayIdx];
    const currentRevealRank = arrayIdx + 1; // rank of clip being revealed now (1=best, N=worst)

    const input   = path.join(base, 'processed', clipId, 'clean.mp4');
    if (!fs.existsSync(input)) { console.error(`  [RANK:SEG] No clean.mp4: ${clipId}`); tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} }); return false; }

    const assFile = path.join(base, 'processed', clipId, 'captions-vertical.ass');
    const short   = editorialClips[clipId]?.short;
    const hasAss  = fs.existsSync(assFile) && !(short?.noSubs);
    const mode    = short?.mode || 'desktop';
    const punchStep = buildPunchFilter(input, short);
    const punch   = punchStep ? `${punchStep},` : '';

    const activeAssFile = assFile;
    // Captions run to end (outro removed — no trimming needed)
    // const trimmedAssPath = null; // kept for reference if outro is re-enabled

    // Build base vertical video filter (same as renderSegmentVertical)
    let vFilterParts;
    if (mode === 'mobile') {
      const c = short?.mobile || { x: 34.18, y: 0, w: 31.64, h: 100 };
      const cw = px(c.w,'w'), ch = px(c.h,'h'), cx = px(c.x,'w'), cy = px(c.y,'h');
      const cropStr = `crop=${cw}:${ch}:${cx}:${cy},${punch}scale=1080:1920`;
      vFilterParts = hasAss
        ? [`[0:v]${cropStr},ass=${ffmpegPath(activeAssFile)}[seg_base]`]
        : [`[0:v]${cropStr}[seg_base]`];
    } else if (mode === 'split' && short?.split) {
      const sp = short.split;
      const ratio  = sp.ratio ?? 0.7;
      const GAME_H = even(Math.round(1920 * ratio));
      const CAM_H  = 1920 - GAME_H;
      const g  = sp.gameplay || { x: 0, y: 0, w: 100, h: 100 };
      const wc = sp.webcam   || { x: 2,  y: 2, w: 30,  h: 30  };
      vFilterParts = [
        '[0:v]split=2[vs1][vs2]',
        `[vs1]crop=${px(wc.w,'w')}:${px(wc.h,'h')}:${px(wc.x,'w')}:${px(wc.y,'h')},scale=1080:${CAM_H}[cam]`,
        `[vs2]crop=${px(g.w,'w')}:${px(g.h,'h')}:${px(g.x,'w')}:${px(g.y,'h')},${punch}scale=1080:${GAME_H}[game]`,
        '[cam][game]vstack=inputs=2[stacked]',
        hasAss ? `[stacked]ass=${ffmpegPath(activeAssFile)}[seg_base]` : '[stacked]renamed_to_seg_base',
      ];
      if (!hasAss) vFilterParts[vFilterParts.length - 1] = '[stacked]setsar=1[seg_base]';
    } else {
      const c = short?.desktop || { x: 0, y: 0, w: 100, h: 100 };
      const cropStep = c.w >= 99 ? '' : `crop=${px(c.w,'w')}:${px(c.h,'h')}:${px(c.x,'w')}:${px(c.y,'h')},`;
      const blurFilters = [
        `[0:v]${cropStep}split[main_r][bg_r]`,
        '[bg_r]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5,eq=brightness=-0.3[blurred_r]',
        `[main_r]${punch}scale=1080:-2[fg_r]`,
      ];
      const lastBlur = hasAss
        ? `[blurred_r][fg_r]overlay=(W-w)/2:(H-h)/2,ass=${ffmpegPath(activeAssFile)}[seg_base]`
        : `[blurred_r][fg_r]overlay=(W-w)/2:(H-h)/2[seg_base]`;
      vFilterParts = [...blurFilters, lastBlur];
    }

    // Add ranking panel
    const { parts: panelParts, lastPad } = buildRankingPanelFilters(N, currentRevealRank, streamerNames, '[seg_base]');
    const allFilters = [...vFilterParts, ...panelParts, `${lastPad}setsar=1[out]`];

    const tmpOut = path.join(tmpDir, `_rank_${k}.mp4`);
    const r = await ffmpegAsync([
      '-i', input,
      '-filter_complex', allFilters.join(';'),
      '-map', '[out]', '-map', '0:a',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-c:a', 'copy',
      '-y', tmpOut
    ]);

    if (r.status !== 0) {
      console.error(`  [RANK:SEG FAIL] ${clipId}`, (r.stderr || '').split('\n').filter(l => /error/i.test(l)).slice(0, 3).join('\n'));
      tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
      return false;
    }
    console.log(`  [RANK:SEG] #${currentRevealRank}/${N} ${clipId.slice(0, 24)} (${segDurs[arrayIdx].toFixed(1)}s)`);
    tmpFiles.push(tmpOut);
  }

  // Concat all segments (worst→best order in tmpFiles) — сегменти в ідентичному
  // форматі, тому -c copy; без intro concat пише одразу фінальний файл.
  const concatListPath = path.join(tmpDir, '_rank_concat.txt');
  fs.writeFileSync(concatListPath, tmpFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
  const concatTmpPath = path.join(tmpDir, '_rank_tmp.mp4');
  const rConcat = await ffmpegAsync(introText
    ? ['-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', '-y', concatTmpPath]
    : ['-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', '-movflags', '+faststart', '-y', outPath]);
  tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  try { fs.unlinkSync(concatListPath); } catch {}

  if (rConcat.status !== 0) {
    console.error('[RANK:CONCAT FAIL]', (rConcat.stderr || '').split('\n').slice(-5).join('\n'));
    return false;
  }

  if (!introText) return true;

  // Apply intro (outro removed — one file for all platforms)
  const rankIntroFilterStr = ['[0:v]setsar=1[pre_out]', ...buildIntroFilters(introText)].join(';');
  const rFinal = await ffmpegAsync([
    '-i', concatTmpPath,
    '-filter_complex', rankIntroFilterStr,
    '-map', '[out]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-y', outPath
  ]);
  try { fs.unlinkSync(concatTmpPath); } catch {}

  if (rFinal.status !== 0) {
    console.error('[RANK:FINAL FAIL]', (rFinal.stderr || '').split('\n').slice(-5).join('\n'));
    return false;
  }
  return true;
}

async function processItem(item) {
  const { type, primaryId, clips, labels } = item;
  const output   = path.join(outDir, `${primaryId}.mp4`);
  const introText = introTextMap[primaryId] || '';

  if (type === 'ranking') {
    console.log(`[SHORT:RANKING] ${primaryId.slice(0, 24)} (${clips.length} clips)`);
    const ok = await renderRankingShort(primaryId, clips, output, introText, labels);
    if (ok) console.log(`[OK] ${primaryId.slice(0, 32)} (ranking)`);
    else console.error(`[FAIL] ${primaryId} (ranking)`);
    return ok;
  }

  if (type === 'merge') {
    console.log(`[SHORT:MERGE] ${primaryId.slice(0, 24)} + ${clips.length - 1} more`);
    const ok = await renderCombinedShort(primaryId, clips, output, introText);
    if (ok) console.log(`[OK] ${primaryId.slice(0, 32)} (merge)`);
    else console.error(`[FAIL] ${primaryId} (merge)`);
    return ok;
  }

  return processClip(primaryId);
}

async function main() {
  console.log(`\n=== render-shorts.js — ${projectDir} ===`);
  console.log(`Rendering ${shortItems.length} shorts (concurrency: ${CONCURRENCY})\n`);

  let ok = 0, fail = 0;
  let i = 0;
  async function worker() {
    while (i < shortItems.length) {
      const item = shortItems[i++];
      if (await processItem(item)) ok++; else fail++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, shortItems.length) }, worker));

  console.log(`\nDone. ${ok} ok, ${fail} failed.\n`);

  updateState(base, s => {
    s.stages = s.stages || {};
    s.stages.renderShorts = stageStatus(ok, fail);
    s.outputs = s.outputs || {};
    const renderedPaths = shortItems
      .map(item => path.join(outDir, `${item.primaryId}.mp4`))
      .filter(p => fs.existsSync(p));
    // --clip only re-renders one short — merge into the existing list instead
    // of replacing it wholesale, or a single-clip re-render would wipe out
    // every other short's recorded path.
    s.outputs.shortsPaths = clipArg
      ? [...new Set([...(s.outputs.shortsPaths || []), ...renderedPaths])].filter(p => fs.existsSync(p))
      : renderedPaths;
  });
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
