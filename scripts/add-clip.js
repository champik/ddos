#!/usr/bin/env node
// DDOS — add-clip: додати один або кілька Twitch-кліпів до активного run вручну.
// Usage: node scripts/add-clip.js <url1> [url2 ...] [--run <runId>]

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { readJsonSafe, writeJsonAtomic, updateState } = require('./lib/state');
const { downloadClip } = require('./lib/download');
const { getProjectDir, findAllProjects, monthFolderFromRunId } = require('./lib/project-path');
const { computeBroadcastedAt } = require('./lib/select');

// ── env ────────────────────────────────────────────────────────────────────
require('./lib/env').loadEnv();

const CLIENT_ID     = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

// ── helpers ────────────────────────────────────────────────────────────────
function extractSlug(url) {
  const m = url.match(/\/clip\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// Twitch GQL — отримує video_id і vod_offset для кліпів де REST API повертає порожні значення.
// Використовує публічний client-id Twitch веб-сайту (той самий що yt-dlp).
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

async function fetchVodInfoGql(slugs) {
  // Batch: one request per slug (GQL supports arrays of operations)
  const body = JSON.stringify(slugs.map(slug => ({
    operationName: 'ClipVodInfo',
    variables: { slug },
    query: 'query ClipVodInfo($slug: ID!) { clip(slug: $slug) { id slug videoOffsetSeconds video { id } } }',
  })));
  const res = await httpsPost({
    hostname: 'gql.twitch.tv',
    path: '/gql',
    method: 'POST',
    headers: {
      'Client-ID': GQL_CLIENT_ID,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  const map = {};
  for (const item of (Array.isArray(res) ? res : [res])) {
    const clip = item?.data?.clip;
    if (!clip) continue;
    const key = clip.slug || clip.id;
    map[key] = {
      video_id:   clip.video?.id || '',
      vod_offset: clip.videoOffsetSeconds ?? null,
    };
  }
  return map;
}

async function getToken() {
  if (process.env.TWITCH_TOKEN) return process.env.TWITCH_TOKEN;
  const body = `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`;
  const res = await httpsPost({
    hostname: 'id.twitch.tv', path: '/oauth2/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  if (!res.access_token) throw new Error('No access_token: ' + JSON.stringify(res));
  return res.access_token;
}

function twitchGet(path_, token) {
  return httpsGet({
    hostname: 'api.twitch.tv', path: path_, method: 'GET',
    headers: { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${token}` }
  });
}

// ── run discovery ──────────────────────────────────────────────────────────
function findActiveRun() {
  const candidates = [];
  for (const { runId, projectDir } of findAllProjects()) {
    const sp = path.join(projectDir, 'state.json');
    if (!fs.existsSync(sp)) continue;
    const state = readJsonSafe(sp, {});
    if (state.status === 'published') continue;
    candidates.push({ runId, state });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const ta = a.state.pipelineStartedAt || a.state.startedAt || '';
    const tb = b.state.pipelineStartedAt || b.state.startedAt || '';
    return tb.localeCompare(ta);
  });
  return candidates[0].runId;
}

function createManualRun() {
  const existing = findAllProjects();
  const nums = existing
    .map(({ runId }) => { const m = runId.match(/^Manual_(\d+)_/); return m ? parseInt(m[1]) : 0; })
    .filter(Boolean);
  const n = nums.length ? Math.max(...nums) + 1 : 1;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '_');
  const runId  = `Manual_${n}_${date}`;
  const month  = monthFolderFromRunId(runId);
  if (month) fs.mkdirSync(path.join('projects', month), { recursive: true });
  const runDir = getProjectDir(runId);
  fs.mkdirSync(path.join(runDir, 'clips'),     { recursive: true });
  fs.mkdirSync(path.join(runDir, 'downloads'), { recursive: true });
  writeJsonAtomic(path.join(runDir, 'state.json'), {
    runId,
    startedAt: new Date().toISOString(),
    stages: { ingest: 'done', download: 'done' },
    counts:  { raw: 0, downloaded: 0 },
    manual:  true,
  });
  writeJsonAtomic(path.join(runDir, 'clips', 'raw-clips.json'),        []);
  writeJsonAtomic(path.join(runDir, 'clips', 'downloaded-clips.json'), []);
  return runId;
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node scripts/add-clip.js <url1> [url2 ...] [--run <runId>]');
    process.exit(1);
  }

  let explicitRun = null;
  const urls = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run' && args[i + 1]) { explicitRun = args[++i]; }
    else { urls.push(args[i]); }
  }

  // Extract slugs
  const slugs = [];
  for (const url of urls) {
    const slug = extractSlug(url);
    if (slug) { slugs.push(slug); }
    else { console.warn(`[add-clip] Не вдалося витягти clipId з: ${url}`); }
  }
  if (!slugs.length) { console.error('[add-clip] Жодного валідного URL'); process.exit(1); }

  console.log(`[add-clip] ${slugs.length} clip(s): ${slugs.join(', ')}`);

  // Auth
  console.log('[add-clip] Отримую токен...');
  const token = await getToken();

  // Fetch clip metadata (batch up to 100 per request)
  console.log('[add-clip] Запит метаданих з Twitch API...');
  const clipsRaw = [];
  for (let i = 0; i < slugs.length; i += 100) {
    const batch  = slugs.slice(i, i + 100);
    const params = batch.map(s => `id=${encodeURIComponent(s)}`).join('&');
    const res    = await twitchGet(`/helix/clips?${params}`, token);
    clipsRaw.push(...(res.data || []));
  }

  if (!clipsRaw.length) {
    console.error('[add-clip] Twitch API повернув 0 кліпів. Перевір URL або видимість кліпу.');
    process.exit(1);
  }

  // Fetch game names
  const gameIds = [...new Set(clipsRaw.map(c => c.game_id).filter(Boolean))];
  const gamesMap = {};
  if (gameIds.length) {
    const params = gameIds.map(id => `id=${id}`).join('&');
    const res = await twitchGet(`/helix/games?${params}`, token);
    for (const g of (res.data || [])) gamesMap[g.id] = g.name;
  }

  // GQL fallback: get vod_offset / video_id for clips REST API left empty
  const needGql = clipsRaw.filter(c => !c.video_id).map(c => c.id);
  let gqlVodMap = {};
  if (needGql.length) {
    console.log(`[add-clip] GQL fallback для ${needGql.length} кліп(ів) без VOD info...`);
    try {
      gqlVodMap = await fetchVodInfoGql(needGql);
      for (const slug of needGql) {
        const info = gqlVodMap[slug];
        if (info) console.log(`  • ${slug}: video_id=${info.video_id || 'n/a'}, vod_offset=${info.vod_offset ?? 'n/a'}`);
        else      console.log(`  • ${slug}: VOD не знайдено (можливо видалений)`);
      }
    } catch (e) {
      console.warn(`  [WARN] GQL запит не вдався: ${e.message}`);
    }
  }

  // Enrich
  const clips = clipsRaw.map(c => {
    const login = c.url ? new URL(c.url).pathname.split('/').filter(Boolean)[0] : undefined;
    const gql   = gqlVodMap[c.id] || {};
    return {
      ...c,
      video_id:   c.video_id   || gql.video_id   || '',
      vod_offset: c.vod_offset ?? gql.vod_offset ?? null,
      game_name: gamesMap[c.game_id] || 'Unknown',
      ...(login ? { broadcaster_login: login } : {}),
      _manual: true,
    };
  });

  console.log(`[add-clip] Отримано ${clips.length}/${slugs.length}:`);
  for (const c of clips) {
    console.log(`  • ${c.broadcaster_name} — "${c.title}" (${c.game_name}, ${c.view_count} views, ${c.duration}s)`);
  }
  const notFound = slugs.filter(s => !clipsRaw.find(c => c.id === s));
  if (notFound.length) console.warn(`  [WARN] Не знайдено в API: ${notFound.join(', ')}`);

  // Resolve run
  const runId  = explicitRun || findActiveRun() || createManualRun();
  const runDir = getProjectDir(runId);
  const clipsDir    = path.join(runDir, 'clips');
  const downloadsDir = path.join(runDir, 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  console.log(`[add-clip] Run: ${runId}`);

  // raw-clips.json
  const rawPath  = path.join(clipsDir, 'raw-clips.json');
  const rawClips = fs.existsSync(rawPath) ? readJsonSafe(rawPath, []) : [];
  const rawIds   = new Set(rawClips.map(c => c.id));
  let addedRaw   = 0;
  for (const c of clips) { if (!rawIds.has(c.id)) { rawClips.push(c); addedRaw++; } }
  if (addedRaw) writeJsonAtomic(rawPath, rawClips);

  // Enrich broadcastedAt from VOD start time
  const vodIds = [...new Set(clips.filter(c => c.video_id).map(c => c.video_id))];
  if (vodIds.length) {
    try {
      const params = vodIds.map(id => `id=${encodeURIComponent(id)}`).join('&');
      const res = await twitchGet(`/helix/videos?${params}`, token);
      const vodMap = new Map((res.data || []).map(v => [v.id, v.created_at]));
      for (const c of clips) {
        const { broadcastedAt, broadcastedAtSource } = computeBroadcastedAt(c, vodMap.get(c.video_id));
        c.broadcastedAt = broadcastedAt;
        c.broadcastedAtSource = broadcastedAtSource;
      }
    } catch (e) {
      console.warn(`  [WARN] VOD time fetch failed: ${e.message}`);
      for (const c of clips) { c.broadcastedAt = c.created_at; c.broadcastedAtSource = 'clip'; }
    }
  } else {
    for (const c of clips) { c.broadcastedAt = c.created_at; c.broadcastedAtSource = 'clip'; }
  }

  // Download
  console.log(`[add-clip] Завантажую...`);
  const downloaded = [];
  for (const clip of clips) {
    const result = await downloadClip(clip, downloadsDir);
    if (result.status === 'ok' || result.status === 'skipped') {
      const localPath = path.join(runDir, 'downloads', result.filename).replace(/\\/g, '/');
      downloaded.push({ ...clip, localPath });
      const tag = result.status === 'skipped' ? '[skip]' : '[ok]';
      console.log(`  ✓ ${tag} ${result.filename}`);
    } else {
      console.error(`  ✗ [error] ${clip.broadcaster_name}: ${result.error}`);
    }
  }

  // downloaded-clips.json
  const dlPath  = path.join(clipsDir, 'downloaded-clips.json');
  const dlClips = fs.existsSync(dlPath) ? readJsonSafe(dlPath, []) : [];
  const dlIds   = new Set(dlClips.map(c => c.id));
  for (const c of downloaded) {
    if (dlIds.has(c.id)) {
      const idx = dlClips.findIndex(e => e.id === c.id);
      if (idx >= 0) dlClips[idx] = c;
    } else {
      dlClips.push(c);
    }
  }
  writeJsonAtomic(dlPath, dlClips);

  // State counts
  updateState(runDir, s => {
    s.counts = s.counts || {};
    s.counts.raw        = rawClips.length;
    s.counts.downloaded = dlClips.length;
  });

  console.log(`\n✅ Готово! ${downloaded.length} кліп(ів) → ${runId}`);
  console.log(`   raw-clips:        ${rawClips.length} total`);
  console.log(`   downloaded-clips: ${dlClips.length} total`);

  // Regenerate edit.html if it already exists for this run
  const editHtmlPath = path.join(runDir, 'edit', 'edit.html');
  if (fs.existsSync(editHtmlPath)) {
    const { spawnSync } = require('child_process');
    console.log('[add-clip] Оновлюю edit.html...');
    const r = spawnSync(process.execPath, ['scripts/gen-editorial.js', runId], { encoding: 'utf8' });
    if (r.status === 0) console.log('[add-clip] edit.html оновлено — перезавантаж сторінку в браузері');
    else console.warn('[add-clip] gen-editorial помилка:\n' + (r.stderr || r.stdout));
  }
}

main().catch(e => {
  console.error('[add-clip] Fatal:', e.message);
  process.exit(1);
});
