#!/usr/bin/env node
// DDOS Pipeline — INGEST + FILTER + SELECT (month mode, recency-compensation)
// Usage: node scripts/ingest-month.js <runId> --started-at <ISO> --ended-at <ISO>

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { updateState }    = require('./lib/state');
const { JCIRL_IDS, SPECIALTY_IDS } = require('./lib/categories');
const { pickByPopularity, diversityFloor } = require('./lib/select');
const { getProjectDir, monthFolderFromRunId } = require('./lib/project-path');

const [,, runId, ...flags] = process.argv;

const startedAtArg = flags.indexOf('--started-at');
const endedAtArg   = flags.indexOf('--ended-at');
const STARTED_AT   = startedAtArg >= 0 ? flags[startedAtArg + 1] : null;
const ENDED_AT     = endedAtArg   >= 0 ? flags[endedAtArg   + 1] : null;
const MAX_CANDIDATES = 500;

if (!runId || !STARTED_AT || !ENDED_AT) {
  console.error('Usage: node scripts/ingest-month.js <runId> --started-at <ISO> --ended-at <ISO>');
  process.exit(1);
}

const _month = monthFolderFromRunId(runId);
if (_month) fs.mkdirSync(path.join('projects', _month), { recursive: true });
const RUN_DIR  = getProjectDir(runId);
const CLIPS_DIR = path.join(RUN_DIR, 'clips');
fs.mkdirSync(CLIPS_DIR, { recursive: true });

require('./lib/env').loadEnv();

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const tokenFlag = flags.indexOf('--token');
const TOKEN     = (tokenFlag >= 0 ? flags[tokenFlag + 1] : null) || process.env.TWITCH_TOKEN;

function httpsGetOnce(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${TOKEN}` }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function httpsGet(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    let res;
    try { res = await httpsGetOnce(url); }
    catch (e) { lastErr = e; await sleep(1000 * 2 ** i); continue; }
    if (res.status === 401) throw new Error('Twitch API 401 — токен недійсний.');
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = parseInt(res.headers['ratelimit-reset'] || '0', 10);
      const waitMs = res.status === 429 && retryAfter
        ? Math.max(0, retryAfter * 1000 - Date.now()) || 1000 * 2 ** i
        : 1000 * 2 ** i;
      lastErr = new Error(`Twitch API ${res.status}`);
      await sleep(Math.min(waitMs, 15000));
      continue;
    }
    try { return JSON.parse(res.body); }
    catch { throw new Error(`JSON parse (HTTP ${res.status}): ` + res.body.slice(0, 200)); }
  }
  throw lastErr || new Error('Twitch API: всі спроби вичерпано');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchClipsPage(gameId, startedAt, endedAt, after) {
  let url = `https://api.twitch.tv/helix/clips?game_id=${gameId}&started_at=${encodeURIComponent(startedAt)}&ended_at=${encodeURIComponent(endedAt)}&first=100`;
  if (after) url += `&after=${after}`;
  return httpsGet(url);
}

async function fetchClipsForCategory(gameId, pages) {
  const clips = [];
  let cursor = null;
  for (let i = 0; i < pages; i++) {
    const page = await fetchClipsPage(gameId, STARTED_AT, ENDED_AT, cursor);
    if (page.data) clips.push(...page.data);
    cursor = page.pagination?.cursor;
    await sleep(80);
    if (!cursor) break;
  }
  return clips;
}

// Day of month from ISO string (1-indexed)
function dayOfMonth(isoStr) {
  return new Date(isoStr).getUTCDate();
}

// Recency-compensation: window slots on top of base pick.
// Only clips NOT already in basePick are eligible.
function recencyWindows(pool, basePick, windows) {
  const pickedIds = new Set(basePick.map(c => c.id));
  const result = [];
  for (const { dayStart, dayEnd, slots } of windows) {
    const eligible = pool
      .filter(c => !pickedIds.has(c.id))
      .filter(c => {
        const day = dayOfMonth(c.created_at);
        return day >= dayStart && day <= dayEnd;
      })
      .sort((a, b) => b.view_count - a.view_count);
    let added = 0;
    for (const c of eligible) {
      if (added >= slots) break;
      result.push(c);
      pickedIds.add(c.id);
      added++;
    }
  }
  return result;
}

// Diversity add-on: 1 clip per streamer not yet represented
function diversityAddOn(pool, alreadySelected, limit) {
  const represented = new Set(alreadySelected.map(c => c.broadcaster_name));
  const pickedIds   = new Set(alreadySelected.map(c => c.id));
  const bestByStreamer = new Map();
  for (const c of pool) {
    if (represented.has(c.broadcaster_name)) continue;
    if (pickedIds.has(c.id)) continue;
    if (!bestByStreamer.has(c.broadcaster_name)) bestByStreamer.set(c.broadcaster_name, c);
    else if (c.view_count > bestByStreamer.get(c.broadcaster_name).view_count)
      bestByStreamer.set(c.broadcaster_name, c);
  }
  return [...bestByStreamer.values()]
    .sort((a, b) => b.view_count - a.view_count)
    .slice(0, limit);
}

async function main() {
  console.log(`[INGEST-MONTH] runId=${runId} period=${STARTED_AT} → ${ENDED_AT}`);

  const CORE = [
    { id: '509658', name: 'Just Chatting' },
    { id: '509672', name: 'IRL' },
    { id: '26936',  name: 'Music' },
    { id: '116747788', name: 'Pools, Hot Tubs, and Beaches' },
    { id: '32399',  name: 'Counter-Strike 2' },
    { id: '516575', name: 'Valorant' },
    { id: '21779',  name: 'League of Legends' },
    { id: '29595',  name: 'Dota 2' },
    { id: '493057', name: 'PUBG: BATTLEGROUNDS' },
  ];
  const CORE_IDS  = new Set(CORE.map(c => c.id));
  const BAN_KEYWORDS = ['slots','casino','gambling','betting','poker','tarkov','overwatch',
    'marvel rivals','sports betting','dark and darker','path of exile'];

  console.log('[INGEST-MONTH] Fetching top games for dynamic categories...');
  const topGamesData = await httpsGet('https://api.twitch.tv/helix/games/top?first=50');
  const dynamic = (topGamesData.data || [])
    .filter(g => !CORE_IDS.has(g.id) && !BAN_KEYWORDS.some(k => g.name.toLowerCase().includes(k)))
    .slice(0, 10)
    .map(g => ({ id: g.id, name: g.name }));

  console.log(`[INGEST-MONTH] Dynamic categories (${dynamic.length}): ${dynamic.map(d => d.name).join(', ')}`);

  const allCategories = [...CORE, ...dynamic];
  const allClips = [];
  const seen = new Set();

  for (const cat of allCategories) {
    // Month fetch: 5 pages for JC/IRL (more clips span the month), 2 pages for others
    const pages = JCIRL_IDS.has(cat.id) ? 5 : 2;
    console.log(`[INGEST-MONTH] Fetching ${cat.name} (${cat.id}), ${pages} pages...`);
    try {
      const clips = await fetchClipsForCategory(cat.id, pages);
      let added = 0;
      for (const c of clips) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          const login = c.url ? (new URL(c.url).pathname.split('/').filter(Boolean)[0] || undefined) : undefined;
          allClips.push({ ...c, game_id: cat.id, game_name: cat.name, ...(login ? { broadcaster_login: login } : {}) });
          added++;
        }
      }
      console.log(`  → ${clips.length} fetched, ${added} new (total: ${allClips.length})`);
    } catch (e) {
      console.error(`  [ERROR] ${cat.name}: ${e.message}`);
    }
    await sleep(150);
  }

  console.log(`[INGEST-MONTH] Total raw clips: ${allClips.length}`);
  fs.writeFileSync(path.join(CLIPS_DIR, 'raw-clips.json'), JSON.stringify(allClips, null, 2));
  updateState(RUN_DIR, s => { s.counts.raw = allClips.length; s.stages.ingest = 'done'; s.stages.filter = 'running'; });

  // ---- FILTER ----
  console.log('[FILTER] Starting...');

  const ORG_BLACKLIST = new Set([
    'esl_csgo','eslcs','eslcsb','blasttv','pgl','riotgames','valorant','esl_dota2',
    'weplay_esports','faceit','dreamhack','esltv','iem',
    'espn','espn2','nba','nfl','mlb','nhl','ufc','cnn','bbcnews','skynews',
    'twitch','twitchgaming','twitchrivals','gamespot','ign','kotaku',
    'lolesports','lcs','lec','lck','lpl','dota2ti','pgl_dota2',
    'overwatchleague','callofduty','fifa','pubg_battlegrounds',
  ]);
  const STREAMER_BLACKLIST = new Set(['lyasyaa','qoqsik','vedal987','miladeva','winningbikini','panterochka_','lily_off_valley']);
  const RU_KEYWORDS        = ['русский','россия','russian','путін','рф'];
  const TOURNAMENT_KEYWORDS = [' major',' grand final','championship',' tournament','qualifier'];
  const BANNED_GAMES       = ['slots','casino','gambling','betting','poker','tarkov','overwatch',
    'marvel rivals','sports betting','dark and darker','path of exile'];

  console.log('[FILTER] Fetching VTuber tags...');
  const uniqueBroadcasterIds = [...new Set(allClips.map(c => c.broadcaster_id).filter(Boolean))];
  const vtuberBroadcasterIds = new Set();
  for (let i = 0; i < uniqueBroadcasterIds.length; i += 100) {
    const batch = uniqueBroadcasterIds.slice(i, i + 100);
    const params = batch.map(id => `broadcaster_id=${id}`).join('&');
    try {
      const data = await httpsGet(`https://api.twitch.tv/helix/channels?${params}`);
      for (const ch of (data.data || [])) {
        if ((ch.tags || []).map(t => t.toLowerCase()).includes('vtuber'))
          vtuberBroadcasterIds.add(ch.broadcaster_id);
      }
    } catch (e) { console.warn(`  [WARN] channel tags: ${e.message}`); }
    if (i + 100 < uniqueBroadcasterIds.length) await sleep(200);
  }
  console.log(`  VTubers detected: ${vtuberBroadcasterIds.size}`);

  function getRejectReason(clip) {
    const lang     = (clip.language || '').toLowerCase();
    const title    = (clip.title || '').toLowerCase();
    const broadcaster = (clip.broadcaster_name || '').toLowerCase();
    const gameName = (clip.game_name || '').toLowerCase();
    if (lang !== 'en')                                          return 'non_english';
    if (RU_KEYWORDS.some(k => title.includes(k)))              return 'ru_keyword';
    if (STREAMER_BLACKLIST.has(broadcaster))                   return 'streamer_blacklist';
    if (ORG_BLACKLIST.has(broadcaster))                        return 'official_broadcaster';
    if (vtuberBroadcasterIds.has(clip.broadcaster_id))         return 'vtuber';
    if (TOURNAMENT_KEYWORDS.some(k => title.includes(k)))      return 'tournament_event';
    if (BANNED_GAMES.some(k => gameName.includes(k)))          return 'banned_game';
    if (clip.duration < 6 || clip.duration > 90)               return 'duration';
    return null;
  }

  const filtered = [];
  const rejected = [];
  for (const clip of allClips) {
    const r = getRejectReason(clip);
    if (r) rejected.push({ ...clip, rejectReason: r });
    else   filtered.push(clip);
  }

  console.log(`[FILTER] filtered: ${filtered.length}, rejected: ${rejected.length}`);
  fs.writeFileSync(path.join(CLIPS_DIR, 'filtered-clips.json'), JSON.stringify(filtered, null, 2));
  fs.writeFileSync(path.join(CLIPS_DIR, 'rejected-clips.json'), JSON.stringify(rejected, null, 2));
  updateState(RUN_DIR, s => { s.counts.filtered = filtered.length; s.stages.filter = 'done'; s.stages.select = 'running'; });

  // ---- SELECT (month mode: recency-compensation) ----
  console.log('[SELECT-MONTH] Recency-compensation algorithm...');

  const jcIrlFiltered  = filtered.filter(c => JCIRL_IDS.has(c.game_id));
  const gamingFiltered = filtered.filter(c => !JCIRL_IDS.has(c.game_id) && !SPECIALTY_IDS.has(c.game_id));

  const jcIrlPool = jcIrlFiltered.length > MAX_CANDIDATES
    ? [...jcIrlFiltered].sort((a, b) => b.view_count - a.view_count).slice(0, MAX_CANDIDATES)
    : jcIrlFiltered;
  const gamingPool = gamingFiltered.length > MAX_CANDIDATES
    ? [...gamingFiltered].sort((a, b) => b.view_count - a.view_count).slice(0, MAX_CANDIDATES)
    : gamingFiltered;

  console.log(`[SELECT-MONTH] Pools — JC/IRL=${jcIrlPool.length}, Gaming=${gamingPool.length}`);

  // JC/IRL: 80 base + recency windows (5+10+15) + 10 diversity = 120 target
  const jcBase = pickByPopularity(jcIrlPool, { limit: 80, maxPerStreamer: 5, alreadySelected: [] });
  const jcRecency = recencyWindows(jcIrlPool, jcBase, [
    { dayStart: 1,  dayEnd: 15,  slots: 5  },
    { dayStart: 16, dayEnd: 25,  slots: 10 },
    { dayStart: 26, dayEnd: 31,  slots: 15 },
  ]);
  const jcSoFar = [...jcBase, ...jcRecency];
  const jcDiversity = diversityAddOn(jcIrlPool, jcSoFar, 10);
  const jcIrlPick = [...jcSoFar, ...jcDiversity];

  console.log(`[SELECT-MONTH] JC/IRL: ${jcBase.length} base + ${jcRecency.length} recency + ${jcDiversity.length} diversity = ${jcIrlPick.length}`);

  // Gaming: 40 base + recency windows (2+5+8) + 5 diversity = 60 target
  const gBase = pickByPopularity(gamingPool, { limit: 40, maxPerStreamer: 5, maxPerGame: 5, alreadySelected: [] });
  const gRecency = recencyWindows(gamingPool, gBase, [
    { dayStart: 1,  dayEnd: 15,  slots: 2 },
    { dayStart: 16, dayEnd: 25,  slots: 5 },
    { dayStart: 26, dayEnd: 31,  slots: 8 },
  ]);
  const gSoFar = [...gBase, ...gRecency];
  const gDiversity = diversityAddOn(gamingPool, gSoFar, 5);
  const gamingPick = [...gSoFar, ...gDiversity];

  console.log(`[SELECT-MONTH] Gaming: ${gBase.length} base + ${gRecency.length} recency + ${gDiversity.length} diversity = ${gamingPick.length}`);

  const downloadedIds = new Set();
  const toDownload = [];
  for (const c of [...jcIrlPick, ...gamingPick]) {
    if (!downloadedIds.has(c.id)) { downloadedIds.add(c.id); toDownload.push(c); }
  }

  // Enrich with VOD broadcast times
  const vodIds = [...new Set(toDownload.filter(c => c.video_id).map(c => c.video_id))];
  if (vodIds.length > 0) {
    console.log(`[SELECT-MONTH] Fetching VOD times for ${vodIds.length} VODs...`);
    const vodMap = new Map();
    for (let i = 0; i < vodIds.length; i += 100) {
      const batch = vodIds.slice(i, i + 100);
      const params = batch.map(id => `id=${encodeURIComponent(id)}`).join('&');
      try {
        const data = await httpsGet(`https://api.twitch.tv/helix/videos?${params}`);
        for (const vod of (data.data || [])) vodMap.set(vod.id, vod.created_at);
      } catch (e) { console.warn(`  [WARN] VOD: ${e.message}`); }
      if (i + 100 < vodIds.length) await sleep(150);
    }
    let hits = 0;
    for (const clip of toDownload) {
      if (clip.video_id && vodMap.has(clip.video_id) && clip.vod_offset != null) {
        const vodStartMs = new Date(vodMap.get(clip.video_id)).getTime();
        clip.broadcastedAt = new Date(vodStartMs + clip.vod_offset * 1000).toISOString();
        clip.broadcastedAtSource = 'vod';
        hits++;
      } else {
        clip.broadcastedAt = clip.created_at;
        clip.broadcastedAtSource = 'clip';
      }
    }
    console.log(`[SELECT-MONTH] Broadcast times: ${hits} from VOD, ${toDownload.length - hits} from clip.created_at`);
  } else {
    for (const clip of toDownload) { clip.broadcastedAt = clip.created_at; clip.broadcastedAtSource = 'clip'; }
  }

  fs.writeFileSync(path.join(CLIPS_DIR, 'prescore-candidates.json'), JSON.stringify(toDownload, null, 2));
  updateState(RUN_DIR, s => { s.stages.select = 'done'; s.stages.download = 'running'; });

  const jcTotal = toDownload.filter(c => JCIRL_IDS.has(c.game_id)).length;
  const gTotal  = toDownload.filter(c => !JCIRL_IDS.has(c.game_id) && !SPECIALTY_IDS.has(c.game_id)).length;
  console.log(`\n[SELECT-MONTH] Done. Total: ${toDownload.length} — JC/IRL=${jcTotal}, Gaming=${gTotal}`);
  console.log('\nTop 10 by views:');
  [...toDownload].sort((a, b) => b.view_count - a.view_count).slice(0, 10).forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.broadcaster_name} — "${c.title.slice(0, 60)}" (${c.game_name}, ${c.view_count}v)`);
  });
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
