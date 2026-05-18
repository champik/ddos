'use strict';
// ingest-run.js — Twitch ingest + filter + prescore + download
// Usage: node scripts/ingest-run.js <projectFolder> [--hours N]

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, exec } = require('child_process');
const { step } = require('./progress');

// ── args ─────────────────────────────────────────────────────────────
const projectFolder = process.argv[2];
if (!projectFolder) { console.error('Usage: node ingest-run.js <projectFolder>'); process.exit(1); }
const hoursArg = process.argv.indexOf('--hours');
const HOURS = hoursArg !== -1 ? parseInt(process.argv[hoursArg + 1]) : 24;

const PROJECT_DIR = path.join('projects', projectFolder);
const CLIPS_DIR = path.join(PROJECT_DIR, 'clips');
const DOWNLOADS_DIR = path.join(PROJECT_DIR, 'downloads');

// ── env ───────────────────────────────────────────────────────────────
// Load .env manually (dotenv may not be installed)
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

// ── helpers ───────────────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const u = new URL(url);
    const options = {
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': data.length }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function updateState(updates) {
  const statePath = path.join(PROJECT_DIR, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  Object.assign(state, updates);
  if (updates.stages) Object.assign(state.stages, updates.stages);
  if (updates.counts) Object.assign(state.counts, updates.counts);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── core categories ───────────────────────────────────────────────────
const CORE_IDS = new Set(['509658', '509672', '32399', '516575', '26936']);
const GAMBLING_KEYWORDS = ['slots', 'casino', 'gambling', 'betting', 'poker'];
const ORG_ACCOUNTS = new Set([
  'esl_csgo','eslcs','blasttv','pgl','riotgames','valorant','esl_dota2',
  'weplay_esports','faceit','dreamhack','esltv','iem'
]);
const RU_KEYWORDS = ['русский','россия','russian','путін','рф'];

// ─────────────────────────────────────────────────────────────────────
async function main() {
  step(PROJECT_DIR, 1, 'Отримую кліпи з Twitch');
  console.log(`  Project: ${projectFolder} | Hours: ${HOURS}`);

  // ── 1. Get Twitch token ───────────────────────────────────────────
  console.log('\n[1/4] Отримую Twitch token...');
  const tokenRes = await httpsPost(
    'https://id.twitch.tv/oauth2/token',
    `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`
  );
  const TOKEN = tokenRes.access_token;
  if (!TOKEN) { console.error('Failed to get Twitch token:', tokenRes); process.exit(1); }
  console.log('  Token: OK');

  const AUTH_HEADERS = { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${TOKEN}` };

  // ── 2. Get categories ─────────────────────────────────────────────
  console.log('\n[2/4] Отримую категорії...');
  const coreCategories = [
    { id: '509658', name: 'Just Chatting' },
    { id: '509672', name: 'IRL' },
    { id: '32399',  name: 'Counter-Strike 2' },
    { id: '516575', name: 'Valorant' },
    { id: '26936',  name: 'Music' },
  ];

  const topGamesRes = await httpsGet(
    'https://api.twitch.tv/helix/games/top?first=20',
    AUTH_HEADERS
  );
  const dynamicCategories = (topGamesRes.data || [])
    .filter(g => {
      if (CORE_IDS.has(g.id)) return false;
      const nameLower = g.name.toLowerCase();
      if (GAMBLING_KEYWORDS.some(k => nameLower.includes(k))) return false;
      return true;
    })
    .slice(0, 12)
    .map(g => ({ id: g.id, name: g.name }));

  const allCategories = [...coreCategories, ...dynamicCategories];
  console.log(`  Categories: ${allCategories.length} (core: ${coreCategories.length}, dynamic: ${dynamicCategories.length})`);
  allCategories.forEach(c => console.log(`    • ${c.name} (${c.id})`));

  // ── 3. Fetch clips ────────────────────────────────────────────────
  console.log('\n[3/4] Завантажую кліпи...');
  const startedAt = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();
  const allClips = [];
  const seenIds = new Set();

  async function fetchPage(gameId, gameName, after = null) {
    let url = `https://api.twitch.tv/helix/clips?game_id=${gameId}&started_at=${encodeURIComponent(startedAt)}&first=20`;
    if (after) url += `&after=${after}`;
    try {
      const res = await httpsGet(url, AUTH_HEADERS);
      const clips = (res.data || []).map(c => ({ ...c, game_id: gameId, game_name: gameName }));
      const cursor = res.pagination?.cursor;
      return { clips, cursor };
    } catch (e) {
      console.warn(`    WARN: Failed to fetch ${gameName}: ${e.message}`);
      return { clips: [], cursor: null };
    }
  }

  async function skipAndFetch(gameId, gameName, skipPages, fetchPages) {
    let cursor = null;
    for (let i = 0; i < skipPages; i++) {
      const r = await fetchPage(gameId, gameName, cursor);
      cursor = r.cursor;
      if (!cursor) return [];
      await sleep(100);
    }
    const clips = [];
    for (let i = 0; i < fetchPages; i++) {
      const r = await fetchPage(gameId, gameName, cursor);
      clips.push(...r.clips);
      cursor = r.cursor;
      if (!cursor) break;
      await sleep(100);
    }
    return clips;
  }

  // fixed gem categories for deep-range fetching (JC + IRL + Music)
  const gemCatIds = new Set(['509658', '509672', '26936']);

  for (const cat of allCategories) {
    process.stdout.write(`    ${cat.name}...`);

    // Top range: 1 page
    const top = await fetchPage(cat.id, cat.name);
    top.clips.forEach(c => { if (!seenIds.has(c.id)) { seenIds.add(c.id); allClips.push(c); } });
    await sleep(150);

    // Mid range: skip 1, fetch 2
    const mid = await skipAndFetch(cat.id, cat.name, 1, 2);
    mid.forEach(c => { if (!seenIds.has(c.id)) { seenIds.add(c.id); allClips.push(c); } });
    await sleep(150);

    // Hidden gems: skip 3, fetch 1 (only for gem categories)
    if (gemCatIds.has(cat.id)) {
      const gems = await skipAndFetch(cat.id, cat.name, 3, 1);
      gems.forEach(c => { if (!seenIds.has(c.id)) { seenIds.add(c.id); allClips.push(c); } });
      await sleep(150);
    }

    console.log(` ${allClips.length} total`);
  }

  console.log(`\n  Raw clips: ${allClips.length}`);
  fs.writeFileSync(path.join(CLIPS_DIR, 'raw-clips.json'), JSON.stringify(allClips, null, 2));
  updateState({ counts: { raw: allClips.length } });

  // ── 4. FILTER ────────────────────────────────────────────────────
  step(PROJECT_DIR, 2, 'Фільтрація та pre-score');
  console.log('\n[FILTER] Фільтрую кліпи...');

  const filtered = [];
  const rejected = [];
  const ASIAN_LANGS = new Set(['ja', 'ko', 'zh', 'th']);

  function rejectClip(clip, reason) {
    rejected.push({ ...clip, rejectReason: reason });
  }

  for (const clip of allClips) {
    const lang = clip.language || '';
    const title = (clip.title || '').toLowerCase();
    const gameName = (clip.game_name || '').toLowerCase();
    const broadcaster = (clip.broadcaster_name || '').toLowerCase();

    if (lang === 'ru') { rejectClip(clip, 'excluded_language'); continue; }
    if (RU_KEYWORDS.some(k => title.includes(k))) { rejectClip(clip, 'ru_keyword'); continue; }
    if (ORG_ACCOUNTS.has(broadcaster)) { rejectClip(clip, 'tournament_official'); continue; }
    if ([' major',' grand final','championship',' tournament','qualifier'].some(k => title.includes(k))) {
      rejectClip(clip, 'tournament_event'); continue;
    }
    if (GAMBLING_KEYWORDS.some(k => gameName.includes(k))) { rejectClip(clip, 'gambling'); continue; }
    if (clip.duration < 6 || clip.duration > 90) { rejectClip(clip, 'duration'); continue; }
    if (broadcaster === 'lyasyaa') { rejectClip(clip, 'blacklist'); continue; }

    if (ASIAN_LANGS.has(lang)) { rejectClip(clip, 'asian_language'); continue; }

    filtered.push(clip);
  }

  console.log(`  Filtered: ${filtered.length} (rejected: ${rejected.length})`);
  fs.writeFileSync(path.join(CLIPS_DIR, 'filtered-clips.json'), JSON.stringify(filtered, null, 2));
  fs.writeFileSync(path.join(CLIPS_DIR, 'rejected-clips.json'), JSON.stringify(rejected, null, 2));
  updateState({ stages: { ingest: 'done', filter: 'done' }, counts: { filtered: filtered.length } });

  // ── 5. VIRALITY — розрахунок для всіх відфільтрованих кліпів ────
  console.log('\n[VIRALITY] Отримую статистику стрімерів...');
  const { fetchStreamerStats } = require('./fetch-streamer-stats');
  const uniqueBroadcasters = [...new Set(filtered.map(c => c.broadcaster_name))];
  const statsMap = await fetchStreamerStats(uniqueBroadcasters, TOKEN, CLIENT_ID);

  const withVirality = filtered.map(clip => {
    const avgViewers = statsMap.get(clip.broadcaster_name) || 1000;
    const hoursAlive = Math.max((Date.now() - new Date(clip.created_at)) / 3600000, 1);
    const viralityRatio = Math.round((clip.view_count / hoursAlive / avgViewers) * 1000) / 1000;
    return { ...clip, viralityRatio, avgViewers };
  });
  console.log(`  Virality calculated for ${withVirality.length} clips`);

  // ── 6. DOWNLOAD SELECTION — 50 JC/IRL + 5 Music + ~45 gaming ──────────
  const JC_IRL_IDS = new Set(['509658', '509672']);
  const MUSIC_ID   = '26936';
  const MAX_PER_STREAMER = 3;
  const MAX_PER_GAME     = 5;

  const nonAsian = withVirality;

  const selectedIds  = new Set();
  const streamerCount = new Map();
  const gameCount     = new Map();

  function tryAdd(clip, bucket, perGameLimit) {
    if (selectedIds.has(clip.id)) return false;
    const sc = streamerCount.get(clip.broadcaster_name) || 0;
    if (sc >= MAX_PER_STREAMER) return false;
    if (perGameLimit) {
      const gc = gameCount.get(clip.game_id) || 0;
      if (gc >= MAX_PER_GAME) return false;
      gameCount.set(clip.game_id, gc + 1);
    }
    streamerCount.set(clip.broadcaster_name, sc + 1);
    selectedIds.add(clip.id);
    bucket.push(clip);
    return true;
  }

  const byVirality   = [...nonAsian].sort((a, b) => b.viralityRatio - a.viralityRatio);
  const byPopularity = [...nonAsian].sort((a, b) => b.view_count   - a.view_count);

  const jcIrlClips   = (arr) => arr.filter(c =>  JC_IRL_IDS.has(c.game_id));
  const musicClips   = (arr) => arr.filter(c =>  c.game_id === MUSIC_ID);
  const gamingClips  = (arr) => arr.filter(c => !JC_IRL_IDS.has(c.game_id) && c.game_id !== MUSIC_ID);

  // JC/IRL: 40 virality + 10 popularity
  const poolJcIrl = [];
  for (const clip of jcIrlClips(byVirality))   { if (poolJcIrl.length >= 40) break; tryAdd(clip, poolJcIrl, false); }
  for (const clip of jcIrlClips(byPopularity))  { if (poolJcIrl.length >= 50) break; tryAdd(clip, poolJcIrl, false); }

  // Music: 2 virality + 3 popularity
  const poolMusic = [];
  for (const clip of musicClips(byVirality))    { if (poolMusic.length >= 2) break; tryAdd(clip, poolMusic, false); }
  for (const clip of musicClips(byPopularity))  { if (poolMusic.length >= 5) break; tryAdd(clip, poolMusic, false); }

  // Gaming: 35 virality + 10 popularity
  const poolGaming = [];
  for (const clip of gamingClips(byVirality))   { if (poolGaming.length >= 35) break; tryAdd(clip, poolGaming, true); }
  for (const clip of gamingClips(byPopularity)) { if (poolGaming.length >= 45) break; tryAdd(clip, poolGaming, true); }

  const toDownload = [...poolJcIrl, ...poolMusic, ...poolGaming];
  console.log(`  Selected: ${poolJcIrl.length} JC/IRL + ${poolMusic.length} Music + ${poolGaming.length} gaming = ${toDownload.length} clips`);
  fs.writeFileSync(path.join(CLIPS_DIR, 'prescore-candidates.json'), JSON.stringify(toDownload, null, 2));
  updateState({ stages: { prescore: 'done' } });

  // ── 7. DOWNLOAD ───────────────────────────────────────────────────
  step(PROJECT_DIR, 3, `Завантаження кліпів (yt-dlp) — ${toDownload.length} кліпів`);
  console.log('\n[DOWNLOAD] Завантажую кліпи...');

  function buildFilename(clip) {
    const cat = (clip.game_name || 'unknown').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const streamer = (clip.broadcaster_name || 'unknown').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const views = clip.view_count;
    const date = (clip.created_at || '').slice(0, 10).replace(/-/g, '_');
    return `${cat}_${streamer}_${views}_${date}.mp4`;
  }

  function downloadClip(clip) {
    return new Promise((resolve) => {
      const filename = buildFilename(clip);
      const outPath = path.join(DOWNLOADS_DIR, filename);

      if (fs.existsSync(outPath)) {
        resolve({ clip, filename, success: true, skipped: true });
        return;
      }

      const url = clip.url;
      const cmd = `python -m yt_dlp --no-playlist --format "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 --output "${outPath}" --quiet "${url}"`;

      exec(cmd, { timeout: 120000 }, (err) => {
        if (err || !fs.existsSync(outPath)) {
          resolve({ clip, filename, success: false, error: err?.message });
        } else {
          resolve({ clip, filename, success: true });
        }
      });
    });
  }

  // parallel download, max 5 concurrent
  const downloaded = [];
  const downloadFailed = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < toDownload.length; i += CONCURRENCY) {
    const batch = toDownload.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(downloadClip));

    for (const r of results) {
      if (r.success) {
        const localPath = `projects/${projectFolder}/downloads/${r.filename}`;
        downloaded.push({ ...r.clip, localPath });
        const mark = r.skipped ? '↩' : '✓';
        console.log(`  ${mark} ${r.clip.broadcaster_name} — ${r.clip.game_name} (${r.clip.view_count} views)`);
      } else {
        downloadFailed.push(r.clip);
        console.log(`  ✗ FAIL: ${r.clip.broadcaster_name} — ${r.error?.slice(0, 80)}`);
      }
    }
  }

  console.log(`\n  Downloaded: ${downloaded.length} | Failed: ${downloadFailed.length}`);
  fs.writeFileSync(path.join(CLIPS_DIR, 'downloaded-clips.json'), JSON.stringify(downloaded, null, 2));
  updateState({
    stages: { download: 'done' },
    counts: { downloaded: downloaded.length }
  });

  console.log('\n✓ Ingest complete');
  console.log(`  Raw: ${allClips.length} | Filtered: ${filtered.length} | Downloaded: ${downloaded.length}`);
}

main().catch(e => {
  console.error('\n✗ Ingest failed:', e.message);
  process.exit(1);
});
