#!/usr/bin/env node
// DDOS Pipeline — INGEST + FILTER + SELECT
// Usage: node scripts/run-ingest.js <runId> <token> [--hours N]

const fs = require('fs');
const path = require('path');
const https = require('https');

const [,, runId, TOKEN, ...flags] = process.argv;
const hoursArg = flags.indexOf('--hours');
const HOURS = hoursArg >= 0 ? parseInt(flags[hoursArg + 1]) : 24;

const RUN_DIR = path.join('projects', runId);
const CLIPS_DIR = path.join(RUN_DIR, 'clips');

function readEnv() {
  const env = fs.readFileSync('.env', 'utf8');
  for (const line of env.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) process.env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
}
readEnv();

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'Client-ID': CLIENT_ID,
        'Authorization': `Bearer ${TOKEN}`
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getTopGames() {
  const data = await httpsGet('https://api.twitch.tv/helix/games/top?first=20');
  return data.data || [];
}

async function fetchClipsPage(gameId, startedAt, after) {
  let url = `https://api.twitch.tv/helix/clips?game_id=${gameId}&started_at=${startedAt}&first=20`;
  if (after) url += `&after=${after}`;
  return httpsGet(url);
}

async function fetchClipsForCategory(gameId, startedAt, pages = 5) {
  const clips = [];
  let cursor = null;

  for (let i = 0; i < pages; i++) {
    const page = await fetchClipsPage(gameId, startedAt, cursor);
    if (page.data) clips.push(...page.data);
    cursor = page.pagination?.cursor;
    await sleep(80);
    if (!cursor) break;
  }

  return { clips, nextCursor: cursor };
}

async function main() {
  console.log(`[INGEST] runId=${runId} hours=${HOURS}`);

  const startedAt = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();

  // Core categories
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
  const CORE_IDS = new Set(CORE.map(c => c.id));
  const JCIRL_IDS     = new Set(['509658', '509672']);
  const SPECIALTY_IDS = new Set(['26936', '116747788']);

  // Dynamic categories: top-5 from top-20, excluding core and banlist
  const BAN_KEYWORDS = ['slots', 'casino', 'gambling', 'betting', 'poker', 'tarkov', 'overwatch', 'marvel rivals'];
  console.log('[INGEST] Fetching top games...');
  const topGames = await getTopGames();
  const dynamic = topGames
    .filter(g => !CORE_IDS.has(g.id) && !BAN_KEYWORDS.some(k => g.name.toLowerCase().includes(k)))
    .slice(0, 5)
    .map(g => ({ id: g.id, name: g.name }));

  console.log(`[INGEST] Dynamic categories (${dynamic.length}): ${dynamic.map(d => d.name).join(', ')}`);

  const allCategories = [...CORE, ...dynamic];
  const allClips = [];
  const seen = new Set();

  const jcIrlCursors = {};
  for (const cat of allCategories) {
    const pages = JCIRL_IDS.has(cat.id) ? 15 : 5;
    console.log(`[INGEST] Fetching ${cat.name} (${cat.id}), ${pages} pages...`);
    try {
      const { clips, nextCursor } = await fetchClipsForCategory(cat.id, startedAt, pages);
      if (JCIRL_IDS.has(cat.id)) jcIrlCursors[cat.id] = nextCursor;
      let added = 0;
      for (const c of clips) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          allClips.push({ ...c, game_id: cat.id, game_name: cat.name });
          added++;
        }
      }
      console.log(`  → ${clips.length} fetched, ${added} new (total: ${allClips.length})`);
    } catch(e) {
      console.error(`  [ERROR] ${cat.name}: ${e.message}`);
    }
    await sleep(150);
  }

  console.log(`[INGEST] Total raw clips: ${allClips.length}`);
  fs.writeFileSync(path.join(CLIPS_DIR, 'raw-clips.json'), JSON.stringify(allClips, null, 2));

  // Update state
  const state = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'state.json'), 'utf8'));
  state.counts.raw = allClips.length;
  state.stages.ingest = 'done';
  state.stages.filter = 'running';
  fs.writeFileSync(path.join(RUN_DIR, 'state.json'), JSON.stringify(state, null, 2));

  console.log('[INGEST] Done. raw-clips.json saved.');

  // ---- FILTER ----
  console.log('[FILTER] Starting...');

  const ORG_BLACKLIST = new Set([
    // Esports tournament orgs
    'esl_csgo','eslcs','blasttv','pgl','riotgames','valorant','esl_dota2',
    'weplay_esports','faceit','dreamhack','esltv','iem',
    // Official broadcasters / media (not individual streamers)
    'espn','espn2','nba','nfl','mlb','nhl','ufc',
    'cnn','bbcnews','skynews',
    'twitch','twitchgaming','twitchrivals',
    'gamespot','ign','kotaku',
    'lolesports','lcs','lec','lck','lpl',
    'dota2ti','pgl_dota2','epicenter_cs',
    'overwatchleague','callofduty','fifa',
  ]);
  const STREAMER_BLACKLIST = new Set(['lyasyaa', 'qoqsik']);
  const RU_KEYWORDS = ['русский','россия','russian','путін','рф'];
  const TOURNAMENT_KEYWORDS = [' major',' grand final','championship',' tournament','qualifier'];
  const BANNED_GAMES = ['slots','casino','gambling','betting','poker','tarkov','overwatch','marvel rivals','sports betting'];

  // Fetch VTuber tags via channels API (batch, 1-2 requests for all unique broadcaster_ids)
  console.log('[FILTER] Fetching channel tags to detect VTubers...');
  const uniqueBroadcasterIds = [...new Set(allClips.map(c => c.broadcaster_id).filter(Boolean))];
  const vtuberBroadcasterIds = new Set();
  const BATCH_SIZE = 100;
  for (let i = 0; i < uniqueBroadcasterIds.length; i += BATCH_SIZE) {
    const batch = uniqueBroadcasterIds.slice(i, i + BATCH_SIZE);
    const params = batch.map(id => `broadcaster_id=${id}`).join('&');
    try {
      const data = await httpsGet(`https://api.twitch.tv/helix/channels?${params}`);
      for (const ch of (data.data || [])) {
        const tags = (ch.tags || []).map(t => t.toLowerCase());
        if (tags.includes('vtuber')) {
          vtuberBroadcasterIds.add(ch.broadcaster_id);
        }
      }
    } catch (e) {
      console.warn(`  [WARN] channel tags fetch failed: ${e.message}`);
    }
    if (i + BATCH_SIZE < uniqueBroadcasterIds.length) await sleep(200);
  }
  console.log(`  [FILTER] VTubers detected: ${vtuberBroadcasterIds.size}`);

  const filtered = [];
  const rejected = [];

  for (const clip of allClips) {
    const lang = (clip.language || '').toLowerCase();
    const title = (clip.title || '').toLowerCase();
    const broadcaster = (clip.broadcaster_name || '').toLowerCase();
    const gameName = (clip.game_name || '').toLowerCase();

    let rejectReason = null;

    if (lang !== 'en') rejectReason = 'non_english';
    else if (RU_KEYWORDS.some(k => title.includes(k))) rejectReason = 'ru_keyword';
    else if (STREAMER_BLACKLIST.has(broadcaster)) rejectReason = 'streamer_blacklist';
    else if (ORG_BLACKLIST.has(broadcaster)) rejectReason = 'official_broadcaster';
    else if (vtuberBroadcasterIds.has(clip.broadcaster_id)) rejectReason = 'vtuber';
    else if (TOURNAMENT_KEYWORDS.some(k => title.includes(k))) rejectReason = 'tournament_event';
    else if (BANNED_GAMES.some(k => gameName.includes(k))) rejectReason = 'banned_game';
    else if (clip.duration < 6 || clip.duration > 90) rejectReason = 'duration';

    if (rejectReason) {
      rejected.push({ ...clip, rejectReason });
    } else {
      filtered.push(clip);
    }
  }

  console.log(`[FILTER] filtered: ${filtered.length}, rejected: ${rejected.length}`);
  fs.writeFileSync(path.join(CLIPS_DIR, 'filtered-clips.json'), JSON.stringify(filtered, null, 2));
  fs.writeFileSync(path.join(CLIPS_DIR, 'rejected-clips.json'), JSON.stringify(rejected, null, 2));

  // ---- JC/IRL TOPUP ----
  const JCIRL_MIN = 50;
  const JCIRL_TOPUP_NAMES = { '509658': 'Just Chatting', '509672': 'IRL' };
  const seenTopup = new Set(allClips.map(c => c.id));
  let jcIrlCount = filtered.filter(c => JCIRL_IDS.has(c.game_id)).length;

  if (jcIrlCount < JCIRL_MIN) {
    console.log(`[JCIRL-TOPUP] ${jcIrlCount} JC/IRL survived filter, need ${JCIRL_MIN}. Fetching more...`);
    for (const gameId of ['509658', '509672']) {
      let cursor = jcIrlCursors[gameId] || null;
      let pages = 0;
      while (jcIrlCount < JCIRL_MIN && pages < 15) {
        if (!cursor) break;
        let page;
        try { page = await fetchClipsPage(gameId, startedAt, cursor); }
        catch(e) { console.error(`  [TOPUP ERROR] ${e.message}`); break; }
        cursor = page.pagination?.cursor || null;
        pages++;
        for (const c of (page.data || [])) {
          if (seenTopup.has(c.id)) continue;
          seenTopup.add(c.id);
          const clip = { ...c, game_id: gameId, game_name: JCIRL_TOPUP_NAMES[gameId] };
          const lang = (clip.language || '').toLowerCase();
          const title = (clip.title || '').toLowerCase();
          const broadcaster = (clip.broadcaster_name || '').toLowerCase();
          let rejectReason = null;
          if (lang !== 'en') rejectReason = 'non_english';
          else if (RU_KEYWORDS.some(k => title.includes(k))) rejectReason = 'ru_keyword';
          else if (STREAMER_BLACKLIST.has(broadcaster)) rejectReason = 'streamer_blacklist';
          else if (ORG_BLACKLIST.has(broadcaster)) rejectReason = 'tournament_official';
          else if (TOURNAMENT_KEYWORDS.some(k => title.includes(k))) rejectReason = 'tournament_event';
          else if (BANNED_GAMES.some(k => (clip.game_name || '').toLowerCase().includes(k))) rejectReason = 'banned_game';
          else if (clip.duration < 6 || clip.duration > 90) rejectReason = 'duration';
          if (rejectReason) { rejected.push({ ...clip, rejectReason }); }
          else { filtered.push(clip); jcIrlCount++; }
        }
        await sleep(150);
      }
      console.log(`  [TOPUP] ${JCIRL_TOPUP_NAMES[gameId]}: fetched ${pages} extra pages`);
      if (jcIrlCount >= JCIRL_MIN) break;
    }
    console.log(`[JCIRL-TOPUP] Final JC/IRL: ${jcIrlCount}`);
    fs.writeFileSync(path.join(CLIPS_DIR, 'filtered-clips.json'), JSON.stringify(filtered, null, 2));
    fs.writeFileSync(path.join(CLIPS_DIR, 'rejected-clips.json'), JSON.stringify(rejected, null, 2));
  }

  state.counts.filtered = filtered.length;
  state.stages.filter = 'done';
  state.stages.select = 'running';
  fs.writeFileSync(path.join(RUN_DIR, 'state.json'), JSON.stringify(state, null, 2));

  // ---- SELECT ----
  console.log('[SELECT] Fetching streamer avg_viewers for normalized velocity...');
  const { fetchStreamerStats } = require('./fetch-streamer-stats');
  const uniqueStreamers = [...new Set(filtered.map(c => c.broadcaster_name))];
  const streamerStats = await fetchStreamerStats(uniqueStreamers, TOKEN, process.env.TWITCH_CLIENT_ID);

  // Attach avg_viewers to each clip
  for (const c of filtered) {
    c.avg_viewers = streamerStats.get(c.broadcaster_name) || 1000;
  }

  console.log('[SELECT] Picking candidates by normalized velocity + popularity...');

  function velocity(c) {
    const hoursAlive = Math.max((Date.now() - new Date(c.created_at)) / 3600000, 0.5);
    return c.view_count / hoursAlive / (c.avg_viewers || 1000);
  }

  function pickBucket(pool, viralN, popN, maxPerGame, maxPerStreamer) {
    const byVelocity   = [...pool].sort((a, b) => velocity(b) - velocity(a));
    const byPopularity = [...pool].sort((a, b) => b.view_count - a.view_count);

    const seen = new Set();
    const result = [];
    const gameCounts     = new Map();
    const streamerCounts = new Map();

    function tryAdd(c) {
      if (seen.has(c.id)) return;
      if (maxPerGame) {
        const cnt = gameCounts.get(c.game_id) || 0;
        if (cnt >= maxPerGame) return;
        gameCounts.set(c.game_id, cnt + 1);
      }
      if (maxPerStreamer) {
        const cnt = streamerCounts.get(c.broadcaster_name) || 0;
        if (cnt >= maxPerStreamer) return;
        streamerCounts.set(c.broadcaster_name, cnt + 1);
      }
      seen.add(c.id);
      result.push(c);
    }

    const maxTotal = viralN + popN;
    for (const c of byVelocity)   { if (result.length >= viralN) break; tryAdd(c); }
    for (const c of byPopularity) { if (result.length >= maxTotal) break; tryAdd(c); }
    if (result.length < maxTotal) {
      for (const c of byVelocity) { if (result.length >= maxTotal) break; tryAdd(c); }
    }
    return result;
  }

  const jcIrlPool     = filtered.filter(c => JCIRL_IDS.has(c.game_id));
  const specialtyPool = filtered.filter(c => SPECIALTY_IDS.has(c.game_id));
  const gamingPool    = filtered.filter(c => !JCIRL_IDS.has(c.game_id) && !SPECIALTY_IDS.has(c.game_id));

  const jcIrlPick     = pickBucket(jcIrlPool,     30, 20, null, 5);  // up to 50, max 5/streamer
  const specialtyPick = pickBucket(specialtyPool,  7,  3,    6, 5);  // up to 10, max 6/cat, max 5/streamer
  const gamingPick    = pickBucket(gamingPool,     30, 10,    5, 5);  // up to 40, max 5/game, max 5/streamer

  const seen2 = new Set();
  const toDownload = [];
  for (const c of [...jcIrlPick, ...specialtyPick, ...gamingPick]) {
    if (!seen2.has(c.id)) { seen2.add(c.id); toDownload.push(c); }
  }

  // Safety: enforce JC/IRL minimum 50
  const JCIRL_MIN_DL = 50;
  const jcIrlFinal = toDownload.filter(c => JCIRL_IDS.has(c.game_id));
  if (jcIrlFinal.length < JCIRL_MIN_DL) {
    const need = JCIRL_MIN_DL - jcIrlFinal.length;
    const selectedIds = new Set(toDownload.map(c => c.id));
    const extraJcIrl = jcIrlPool
      .filter(c => !selectedIds.has(c.id))
      .sort((a, b) => velocity(b) - velocity(a))
      .slice(0, need);
    const nonJcIrl = toDownload.filter(c => !JCIRL_IDS.has(c.game_id));
    nonJcIrl.sort((a, b) => velocity(a) - velocity(b));
    let removed = 0;
    for (let i = 0; i < toDownload.length && removed < extraJcIrl.length; i++) {
      if (!JCIRL_IDS.has(toDownload[i].game_id)) {
        toDownload.splice(i, 1);
        i--;
        removed++;
      }
    }
    toDownload.push(...extraJcIrl.slice(0, removed));
    console.log(`[SELECT] JC/IRL minimum enforced: swapped ${removed} clips`);
  }

  const jcIrlCount2  = toDownload.filter(c => JCIRL_IDS.has(c.game_id)).length;
  const specCount2   = toDownload.filter(c => SPECIALTY_IDS.has(c.game_id)).length;
  const gamingCount2 = toDownload.filter(c => !JCIRL_IDS.has(c.game_id) && !SPECIALTY_IDS.has(c.game_id)).length;
  console.log(`[SELECT] ${toDownload.length} candidates — JC/IRL=${jcIrlCount2}, Specialty=${specCount2}, Gaming=${gamingCount2}`);

  fs.writeFileSync(path.join(CLIPS_DIR, 'prescore-candidates.json'), JSON.stringify(toDownload, null, 2));

  state.stages.select = 'done';
  state.stages.download = 'running';
  fs.writeFileSync(path.join(RUN_DIR, 'state.json'), JSON.stringify(state, null, 2));

  console.log('[SELECT] Done. prescore-candidates.json saved.');
  console.log('\nTop 10 by velocity:');
  [...toDownload].sort((a, b) => velocity(b) - velocity(a)).slice(0, 10).forEach((c, i) => {
    console.log(`  ${i+1}. ${c.broadcaster_name} — "${c.title.slice(0, 60)}" (${c.game_name}, ${c.view_count} views/hr≈${velocity(c).toFixed(0)})`);
  });
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
