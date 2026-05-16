#!/usr/bin/env node
/**
 * DDOS Ingest — Twitch API → raw-clips.json → filtered → prescore → download
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync, spawnSync } = require('child_process');

const runId = process.argv[2];
const hoursBack = parseInt(process.argv[3] || '24', 10);

if (!runId) { console.error('Usage: node ingest.js <runId> [hoursBack]'); process.exit(1); }

const projectDir = path.join('projects', runId);
const clipsDir = path.join(projectDir, 'clips');
const downloadsDir = path.join(projectDir, 'downloads');

function loadEnv() {
  try {
    const lines = fs.readFileSync('.env', 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  } catch {}
}

function updateState(updates) {
  const statePath = path.join(projectDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const [key, val] of Object.entries(updates)) {
    const parts = key.split('.');
    let obj = state;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = val;
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(opts, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch (e) { reject(new Error('JSON parse: ' + out.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getTwitchToken() {
  const res = await httpsPost('https://id.twitch.tv/oauth2/token', {
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials'
  });
  if (!res.access_token) throw new Error('No access token: ' + JSON.stringify(res));
  return res.access_token;
}

async function fetchClipsPage(gameId, startedAt, cursor, token) {
  let url = `https://api.twitch.tv/helix/clips?game_id=${gameId}&started_at=${startedAt}&first=20`;
  if (cursor) url += `&after=${cursor}`;
  return httpsGet(url, {
    'Client-ID': process.env.TWITCH_CLIENT_ID,
    'Authorization': `Bearer ${token}`
  });
}

async function fetchTopGames(token) {
  return httpsGet('https://api.twitch.tv/helix/games/top?first=20', {
    'Client-ID': process.env.TWITCH_CLIENT_ID,
    'Authorization': `Bearer ${token}`
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchCategoryClips(gameId, token, startedAt) {
  const clips = [];
  try {
    // Top range: 1 page
    const top = await fetchClipsPage(gameId, startedAt, null, token);
    if (top.data) clips.push(...top.data);

    // Mid range: skip 1 page, take 2 pages
    if (top.pagination?.cursor) {
      await sleep(200);
      const mid1 = await fetchClipsPage(gameId, startedAt, top.pagination.cursor, token);
      if (mid1.data) {
        clips.push(...mid1.data);
        if (mid1.pagination?.cursor) {
          await sleep(200);
          const mid2 = await fetchClipsPage(gameId, startedAt, mid1.pagination.cursor, token);
          if (mid2.data) clips.push(...mid2.data);
        }
      }
    }
  } catch (e) {
    console.error(`  Warn: category ${gameId} fetch error: ${e.message}`);
  }
  return clips;
}

async function fetchHiddenGems(gameId, token, startedAt) {
  const clips = [];
  try {
    // Skip 3 pages, take 1
    let cursor = null;
    for (let i = 0; i < 3; i++) {
      await sleep(200);
      const p = await fetchClipsPage(gameId, startedAt, cursor, token);
      if (!p.pagination?.cursor) return [];
      cursor = p.pagination.cursor;
    }
    const gems = await fetchClipsPage(gameId, startedAt, cursor, token);
    if (gems.data) clips.push(...gems.data);
  } catch (e) {
    console.error(`  Warn: gems ${gameId} fetch error: ${e.message}`);
  }
  return clips;
}

const CORE_IDS = ['509658', '509672', '32399', '516575'];
const CORE_CATEGORIES = [
  { gameId: '509658', name: 'Just Chatting' },
  { gameId: '509672', name: 'IRL' },
  { gameId: '32399',  name: 'Counter-Strike 2' },
  { gameId: '516575', name: 'Valorant' }
];

const ORG_ACCOUNTS = new Set([
  'esl_csgo','eslcs','blasttv','pgl','riotgames','valorant','esl_dota2',
  'weplay_esports','faceit','dreamhack','esltv','iem'
]);

const RU_KEYWORDS = ['русский','россия','russian','путін','рф'];
const TOURNAMENT_KEYWORDS = [' major',' grand final','championship',' tournament','qualifier'];
const GAMBLING_KEYWORDS = ['slots','casino','gambling','betting','poker'];

function filterClip(clip) {
  if (clip.language === 'ru') return { ok: false, reason: 'excluded_language' };
  const titleLow = (clip.title || '').toLowerCase();
  if (RU_KEYWORDS.some(k => titleLow.includes(k))) return { ok: false, reason: 'ru_keyword' };
  if (ORG_ACCOUNTS.has((clip.broadcaster_name || '').toLowerCase())) return { ok: false, reason: 'tournament_official' };
  if (TOURNAMENT_KEYWORDS.some(k => titleLow.includes(k))) return { ok: false, reason: 'tournament_event' };
  const gameLow = (clip.game_name || '').toLowerCase();
  if (GAMBLING_KEYWORDS.some(k => gameLow.includes(k))) return { ok: false, reason: 'gambling' };
  if (clip.duration < 6 || clip.duration > 90) return { ok: false, reason: 'duration' };
  return { ok: true };
}

function calcPreScore(clip, broadcasterCount) {
  const viewsScore = Math.min(100, Math.log10(clip.view_count + 1) / Math.log10(500000) * 100);
  const categoryScore = CORE_IDS.includes(clip.game_id) ? 88 : 60;
  const d = clip.duration;
  const durationScore = d >= 15 && d <= 60 ? 100 : d < 15 ? 60 : 70;
  const seen = broadcasterCount.get(clip.broadcaster_name) || 0;
  const diversityScore = seen === 0 ? 100 : seen === 1 ? 75 : seen === 2 ? 45 : 0;
  const ageH = (Date.now() - new Date(clip.created_at)) / 3600000;
  const noveltyScore = ageH <= 24 ? 100 : ageH <= 48 ? 65 : 35;
  const languageScore = clip.language === 'en' ? 100 : clip.language === 'uk' ? 90 : 50;
  const title = (clip.title || '').toLowerCase();
  const riskPenalty = (title.includes('music') || title.includes('song')) ? 15 : 0;
  return (
    viewsScore    * 0.30 +
    categoryScore * 0.20 +
    durationScore * 0.15 +
    diversityScore* 0.20 +
    noveltyScore  * 0.10 +
    languageScore * 0.05 -
    riskPenalty
  );
}

function buildDownloadFilename(clip) {
  const cat = (clip.game_name || 'unknown').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const streamer = clip.broadcaster_name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const views = clip.view_count;
  const date = clip.created_at.slice(0, 10).replace(/-/g, '_');
  return `${cat}_${streamer}_${views}_${date}.mp4`;
}

function dedup(clips) {
  const seen = new Set();
  return clips.filter(c => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}

async function downloadClip(clip, runId) {
  const filename = buildDownloadFilename(clip);
  const outPath = path.join(downloadsDir, filename);
  if (fs.existsSync(outPath)) {
    console.log(`  Skip (exists): ${filename}`);
    return outPath;
  }
  const url = clip.url;
  const result = spawnSync('yt-dlp', [
    '--no-playlist',
    '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--output', outPath,
    '--quiet',
    url
  ], { stdio: 'pipe', encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) {
    console.error(`  Error downloading ${filename}: ${result.stderr?.slice(0, 200)}`);
    return null;
  }
  if (!fs.existsSync(outPath)) {
    // yt-dlp might output .mp4 without explicit extension if file already merged
    console.error(`  Error: output file not found: ${outPath}`);
    return null;
  }
  return outPath;
}

async function runInBatches(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length) await sleep(500);
  }
  return results;
}

async function main() {
  loadEnv();
  console.log(`\n=== DDOS Ingest | Run: ${runId} | Hours: ${hoursBack} ===\n`);

  updateState({ 'stages.ingest': 'running' });

  // === STEP 1: Twitch token ===
  console.log('Getting Twitch token...');
  const token = await getTwitchToken();
  console.log('Token acquired.');

  // === STEP 2: Get top games for dynamic categories ===
  console.log('Fetching top games...');
  const topGames = await fetchTopGames(token);
  const dynamicCategories = [];
  for (const game of (topGames.data || [])) {
    if (dynamicCategories.length >= 12) break;
    if (CORE_IDS.includes(game.id)) continue;
    const nameLow = game.name.toLowerCase();
    if (GAMBLING_KEYWORDS.some(k => nameLow.includes(k))) continue;
    dynamicCategories.push({ gameId: game.id, name: game.name });
  }
  const allCategories = [...CORE_CATEGORIES, ...dynamicCategories];
  console.log(`Categories: ${allCategories.map(c => c.name).join(', ')}`);

  // === STEP 3: Fetch clips ===
  const startedAt = new Date(Date.now() - hoursBack * 3600000).toISOString();
  const allClips = [];
  const gemCategories = allCategories.sort(() => Math.random() - 0.5).slice(0, 4).map(c => c.gameId);

  for (const cat of allCategories) {
    console.log(`  Fetching ${cat.name}...`);
    const clips = await fetchCategoryClips(cat.gameId, token, startedAt);
    for (const c of clips) { c.game_name = c.game_name || cat.name; }
    allClips.push(...clips);
    if (gemCategories.includes(cat.gameId)) {
      await sleep(300);
      const gems = await fetchHiddenGems(cat.gameId, token, startedAt);
      for (const c of gems) { c.game_name = c.game_name || cat.name; }
      allClips.push(...gems);
    }
    await sleep(300);
  }

  const uniqueClips = dedup(allClips);
  console.log(`\nRaw clips: ${uniqueClips.length}`);
  fs.writeFileSync(path.join(clipsDir, 'raw-clips.json'), JSON.stringify(uniqueClips, null, 2));
  updateState({ 'stages.ingest': 'done', 'counts.raw': uniqueClips.length });

  // === STEP 4: Filter ===
  console.log('\nFiltering...');
  updateState({ 'stages.filter': 'running' });
  const filtered = [];
  const rejected = [];
  for (const clip of uniqueClips) {
    const r = filterClip(clip);
    if (r.ok) filtered.push(clip);
    else rejected.push({ ...clip, rejectionReason: r.reason });
  }
  console.log(`Filtered: ${filtered.length} kept, ${rejected.length} rejected`);
  fs.writeFileSync(path.join(clipsDir, 'filtered-clips.json'), JSON.stringify(filtered, null, 2));
  fs.writeFileSync(path.join(clipsDir, 'rejected-clips.json'), JSON.stringify(rejected, null, 2));
  updateState({ 'stages.filter': 'done', 'counts.filtered': filtered.length });

  // === STEP 5: Pre-score ===
  console.log('\nPre-scoring...');
  updateState({ 'stages.prescore': 'running' });
  const broadcasterCount = new Map();
  const scored = filtered.map(clip => {
    const score = calcPreScore(clip, broadcasterCount);
    broadcasterCount.set(clip.broadcaster_name, (broadcasterCount.get(clip.broadcaster_name) || 0) + 1);
    return { ...clip, preScore: score };
  }).sort((a, b) => b.preScore - a.preScore);

  const N = 80;
  const top35 = scored.slice(0, Math.floor(N * 0.35));
  const midPool = scored.slice(Math.floor(scored.length * 0.30), Math.floor(scored.length * 0.70));
  const mid35 = midPool.sort(() => Math.random() - 0.5).slice(0, Math.floor(N * 0.35));
  const gemsPool = scored.slice(Math.floor(scored.length * 0.70), Math.floor(scored.length * 0.90));
  const gems15 = gemsPool.sort(() => Math.random() - 0.5).slice(0, Math.floor(N * 0.15));
  const small10 = scored.filter(c => c.view_count < 10000).sort(() => Math.random() - 0.5).slice(0, Math.floor(N * 0.10));
  const trending5 = scored.filter(c => !CORE_IDS.includes(c.game_id)).slice(0, Math.floor(N * 0.05));
  const toDownload = dedup([...top35, ...mid35, ...gems15, ...small10, ...trending5]).slice(0, 80);

  console.log(`Pre-score candidates: ${toDownload.length}`);
  fs.writeFileSync(path.join(clipsDir, 'prescore-candidates.json'), JSON.stringify(toDownload, null, 2));
  updateState({ 'stages.prescore': 'done' });

  // === STEP 6: Download ===
  console.log(`\nDownloading ${toDownload.length} clips...`);
  updateState({ 'stages.download': 'running' });

  const downloadedClips = [];
  let dlCount = 0;
  const downloadBatch = async (clip) => {
    const localPath = await downloadClip(clip, runId);
    dlCount++;
    if (dlCount % 5 === 0) process.stdout.write(`  [${dlCount}/${toDownload.length}]\n`);
    if (localPath) {
      return { ...clip, localPath };
    }
    return null;
  };

  const results = await runInBatches(toDownload, 5, downloadBatch);
  for (const r of results) {
    if (r) downloadedClips.push(r);
  }

  console.log(`\nDownloaded: ${downloadedClips.length}/${toDownload.length}`);
  fs.writeFileSync(path.join(clipsDir, 'downloaded-clips.json'), JSON.stringify(downloadedClips, null, 2));
  updateState({ 'stages.download': 'done', 'counts.downloaded': downloadedClips.length });

  console.log('\n=== Ingest complete ===');
  console.log(`Raw: ${uniqueClips.length} | Filtered: ${filtered.length} | Downloaded: ${downloadedClips.length}`);
}

main().catch(e => {
  console.error('INGEST ERROR:', e.message);
  updateState({ 'stages.ingest': 'failed' });
  process.exit(1);
});
