#!/usr/bin/env node
// DDOS Pipeline — INGEST + FILTER + PRE-SCORE
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

async function fetchClipsForCategory(gameId, startedAt) {
  const clips = [];
  let cursor = null;

  // Top range: page 1
  const page1 = await fetchClipsPage(gameId, startedAt, null);
  if (page1.data) clips.push(...page1.data);
  cursor = page1.pagination?.cursor;
  await sleep(80);

  // Mid range: skip 1 page, take 2
  if (cursor) {
    const skip1 = await fetchClipsPage(gameId, startedAt, cursor);
    cursor = skip1.pagination?.cursor;
    await sleep(80);
    if (cursor) {
      const mid1 = await fetchClipsPage(gameId, startedAt, cursor);
      if (mid1.data) clips.push(...mid1.data);
      cursor = mid1.pagination?.cursor;
      await sleep(80);
      if (cursor) {
        const mid2 = await fetchClipsPage(gameId, startedAt, cursor);
        if (mid2.data) clips.push(...mid2.data);
        cursor = mid2.pagination?.cursor;
        await sleep(80);
      }
    }
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
    console.log(`[INGEST] Fetching ${cat.name} (${cat.id})...`);
    try {
      const { clips, nextCursor } = await fetchClipsForCategory(cat.id, startedAt);
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

  // Hidden gems: 4 random categories, skip 3 pages
  const gemCats = [...allCategories].sort(() => Math.random() - 0.5).slice(0, 4);
  for (const cat of gemCats) {
    console.log(`[INGEST] Hidden gems: ${cat.name}...`);
    try {
      // Get 3 cursors to skip
      let cursor = null;
      for (let i = 0; i < 3; i++) {
        const p = await fetchClipsPage(cat.id, startedAt, cursor);
        cursor = p.pagination?.cursor;
        await sleep(80);
        if (!cursor) break;
      }
      if (cursor) {
        const gems = await fetchClipsPage(cat.id, startedAt, cursor);
        let added = 0;
        for (const c of (gems.data || [])) {
          if (!seen.has(c.id)) {
            seen.add(c.id);
            allClips.push({ ...c, game_id: cat.id, game_name: cat.name });
            added++;
          }
        }
        console.log(`  → ${added} gems added`);
      }
    } catch(e) {
      console.error(`  [ERROR] gems ${cat.name}: ${e.message}`);
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
    'esl_csgo','eslcs','blasttv','pgl','riotgames','valorant','esl_dota2',
    'weplay_esports','faceit','dreamhack','esltv','iem'
  ]);
  const STREAMER_BLACKLIST = new Set(['lyasyaa']);
  const RU_KEYWORDS = ['русский','россия','russian','путін','рф'];
  const ASIAN_LANGS = new Set(['ja','ko','zh','th']);
  const TOURNAMENT_KEYWORDS = [' major',' grand final','championship',' tournament','qualifier'];
  const GAMBLING_NAMES = ['slots','casino','gambling','betting','poker','tarkov','overwatch','marvel rivals','sports betting'];

  const filtered = [];
  const rejected = [];
  let asianBest = null;

  for (const clip of allClips) {
    const lang = (clip.language || '').toLowerCase();
    const title = (clip.title || '').toLowerCase();
    const broadcaster = (clip.broadcaster_name || '').toLowerCase();
    const gameName = (clip.game_name || '').toLowerCase();

    let rejectReason = null;

    if (lang === 'ru') rejectReason = 'excluded_language';
    else if (RU_KEYWORDS.some(k => title.includes(k))) rejectReason = 'ru_keyword';
    else if (STREAMER_BLACKLIST.has(broadcaster)) rejectReason = 'streamer_blacklist';
    else if (ORG_BLACKLIST.has(broadcaster)) rejectReason = 'tournament_official';
    else if (TOURNAMENT_KEYWORDS.some(k => title.includes(k))) rejectReason = 'tournament_event';
    else if (GAMBLING_NAMES.some(k => gameName.includes(k))) rejectReason = 'gambling';
    else if (clip.duration < 6 || clip.duration > 90) rejectReason = 'duration';
    else if (ASIAN_LANGS.has(lang)) rejectReason = 'asian_language';

    if (rejectReason) {
      rejected.push({ ...clip, rejectReason });
    } else {
      filtered.push(clip);
    }
  }

  // Asian language exception: keep best 1 if visual/international
  // (skip auto-selection here — just keep the filtered list clean)

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
          if (lang === 'ru') rejectReason = 'excluded_language';
          else if (RU_KEYWORDS.some(k => title.includes(k))) rejectReason = 'ru_keyword';
          else if (STREAMER_BLACKLIST.has(broadcaster)) rejectReason = 'streamer_blacklist';
          else if (ORG_BLACKLIST.has(broadcaster)) rejectReason = 'tournament_official';
          else if (TOURNAMENT_KEYWORDS.some(k => title.includes(k))) rejectReason = 'tournament_event';
          else if (GAMBLING_NAMES.some(k => (clip.game_name || '').toLowerCase().includes(k))) rejectReason = 'gambling';
          else if (clip.duration < 6 || clip.duration > 90) rejectReason = 'duration';
          else if (ASIAN_LANGS.has(lang)) rejectReason = 'asian_language';
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
  state.stages.prescore = 'running';
  fs.writeFileSync(path.join(RUN_DIR, 'state.json'), JSON.stringify(state, null, 2));

  // ---- PRE-SCORE ----
  console.log('[PRE-SCORE] Calculating scores...');

  const CORE_IDS_ARR = ['509658','509672','26936','116747788','32399','516575','21779','29595','493057'];

  // Pass 1: broadcaster max views
  const broadcasterMaxViews = new Map();
  for (const clip of filtered) {
    const cur = broadcasterMaxViews.get(clip.broadcaster_name) || 0;
    if (clip.view_count > cur) broadcasterMaxViews.set(clip.broadcaster_name, clip.view_count);
  }

  function calcPreScore(clip, seenStreamers, seenCategories) {
    const hoursAlive = Math.max((Date.now() - new Date(clip.created_at)) / 3600000, 0.5);
    const velocity = clip.view_count / hoursAlive;
    const velocityScore = Math.min(100, (Math.log10(velocity + 1) / Math.log10(5000)) * 100);

    const maxViews = broadcasterMaxViews.get(clip.broadcaster_name) || clip.view_count;
    const ratioScore = Math.min(100, (clip.view_count / Math.max(maxViews, 1)) * 100);

    const categoryScore = CORE_IDS_ARR.includes(clip.game_id) ? 88 : 60;

    const d = clip.duration;
    const durationScore = d >= 15 && d <= 60 ? 100 : d < 15 ? 60 : 70;

    const languageScore = clip.language === 'en' ? 100 : clip.language === 'uk' ? 80 : 20;

    const title = (clip.title || '').toLowerCase();
    const riskPenalty = title.includes('music') || title.includes('song') ? 15 : 0;

    const baseScore = (
      velocityScore * 0.25 +
      ratioScore    * 0.15 +
      categoryScore * 0.25 +
      durationScore * 0.20 +
      languageScore * 0.15
    ) - riskPenalty;

    const streamerCount = seenStreamers.get(clip.broadcaster_name) || 0;
    const categoryCount = seenCategories.get(clip.game_id) || 0;
    const streamerMult  = streamerCount === 0 ? 1.0 : streamerCount === 1 ? 0.85 : 0.70;
    const categoryMult  = categoryCount < 5  ? 1.0 : categoryCount < 10  ? 0.90 : 0.80;

    const isViral = velocityScore > 80 || (ratioScore >= 100 && velocityScore > 60);
    const diversityMult = isViral ? 1.0 : streamerMult * categoryMult;

    return Math.max(0, Math.min(100, baseScore * diversityMult));
  }

  // Pass 2: sort by velocity first, then score
  const seenStreamers  = new Map();
  const seenCategories = new Map();
  const scored = filtered
    .sort((a, b) => {
      const va = a.view_count / Math.max((Date.now() - new Date(a.created_at)) / 3600000, 0.5);
      const vb = b.view_count / Math.max((Date.now() - new Date(b.created_at)) / 3600000, 0.5);
      return vb - va;
    })
    .map(clip => {
      const score = calcPreScore(clip, seenStreamers, seenCategories);
      seenStreamers.set(clip.broadcaster_name, (seenStreamers.get(clip.broadcaster_name) || 0) + 1);
      seenCategories.set(clip.game_id, (seenCategories.get(clip.game_id) || 0) + 1);
      return { ...clip, preScore: score };
    })
    .sort((a, b) => b.preScore - a.preScore);

  // Category buckets
  const JCIRL_IDS    = new Set(['509658', '509672']);
  const SPECIALTY_IDS = new Set(['26936', '116747788']);
  // Gaming = everything else (CS, VALORANT, LoL, Dota2, PUBG + dynamic)

  function pickBucket(pool, viralN, popN, maxPerGame) {
    const byVelocity = [...pool].sort((a, b) => {
      const va = a.view_count / Math.max((Date.now() - new Date(a.created_at)) / 3600000, 0.5);
      const vb = b.view_count / Math.max((Date.now() - new Date(b.created_at)) / 3600000, 0.5);
      return vb - va;
    });
    const byPopularity = [...pool].sort((a, b) => b.view_count - a.view_count);

    const seen = new Set();
    const result = [];
    const gameCounts = new Map();

    function tryAdd(c) {
      if (seen.has(c.id)) return;
      if (maxPerGame) {
        const cnt = gameCounts.get(c.game_id) || 0;
        if (cnt >= maxPerGame) return;
        gameCounts.set(c.game_id, cnt + 1);
      }
      seen.add(c.id);
      result.push(c);
    }

    for (const c of byVelocity)   { if (result.length >= viralN) break; tryAdd(c); }
    for (const c of byPopularity) { if (result.length >= viralN + popN) break; tryAdd(c); }
    return result;
  }

  const jcIrlPool    = scored.filter(c => JCIRL_IDS.has(c.game_id));
  const specialtyPool = scored.filter(c => SPECIALTY_IDS.has(c.game_id));
  const gamingPool   = scored.filter(c => !JCIRL_IDS.has(c.game_id) && !SPECIALTY_IDS.has(c.game_id));

  const jcIrlPick    = pickBucket(jcIrlPool,    30, 20, null);  // up to 50
  const specialtyPick = pickBucket(specialtyPool, 7,  3,    6);  // up to 10, max 6/cat
  const gamingPick   = pickBucket(gamingPool,   30, 10,    5);  // up to 40, max 5/game

  const seen2 = new Set();
  const toDownload = [];
  for (const c of [...jcIrlPick, ...specialtyPick, ...gamingPick]) {
    if (!seen2.has(c.id)) { seen2.add(c.id); toDownload.push(c); }
  }

  // Cap non-English at 20 — keep top by preScore, replace removed slots with next best English
  const NON_EN_MAX = 20;
  const nonEnClips = toDownload.filter(c => c.language !== 'en' && c.language !== 'uk');
  if (nonEnClips.length > NON_EN_MAX) {
    const dropIds = new Set(
      [...nonEnClips].sort((a, b) => a.preScore - b.preScore)
        .slice(0, nonEnClips.length - NON_EN_MAX)
        .map(c => c.id)
    );
    const dropped = toDownload.filter(c => dropIds.has(c.id)).length;
    toDownload.splice(0, toDownload.length, ...toDownload.filter(c => !dropIds.has(c.id)));
    // Fill removed slots with best remaining English clips not yet selected
    const selectedIds = new Set(toDownload.map(c => c.id));
    const extraEn = scored
      .filter(c => !selectedIds.has(c.id) && (c.language === 'en' || c.language === 'uk'))
      .slice(0, dropped);
    toDownload.push(...extraEn);
    console.log(`[PRE-SCORE] Non-EN cap: dropped ${dropped} clips, added ${extraEn.length} EN replacements`);
  }

  console.log(`[PRE-SCORE] Selected ${toDownload.length} clips for download`);
  console.log(`  JC/IRL=${jcIrlPick.length}, Specialty=${specialtyPick.length}, Gaming=${gamingPick.length}`);
  const nonEnFinal = toDownload.filter(c => c.language !== 'en' && c.language !== 'uk').length;
  console.log(`  EN/UK=${toDownload.length - nonEnFinal}, non-EN=${nonEnFinal}`);

  fs.writeFileSync(path.join(CLIPS_DIR, 'prescore-candidates.json'), JSON.stringify(toDownload, null, 2));

  state.stages.prescore = 'done';
  state.stages.download = 'running';
  fs.writeFileSync(path.join(RUN_DIR, 'state.json'), JSON.stringify(state, null, 2));

  console.log('[PRE-SCORE] Done. prescore-candidates.json saved.');
  console.log('\nTop 10 clips by preScore:');
  toDownload.slice(0, 10).forEach((c, i) => {
    console.log(`  ${i+1}. [${c.preScore.toFixed(1)}] ${c.broadcaster_name} — "${c.title.slice(0,60)}" (${c.game_name}, ${c.view_count} views, ${c.duration}s)`);
  });
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
