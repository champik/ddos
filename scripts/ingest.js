#!/usr/bin/env node
// DDOS Pipeline — INGEST + FILTER + SELECT
// Usage: node scripts/ingest.js <runId> [token] [--hours N]
// Token is best passed via env (TWITCH_TOKEN) — argv is visible in the process list.

const fs = require('fs');
const path = require('path');
const { updateState } = require('./lib/state');
const { CORE_CATEGORIES, JCIRL_IDS, SPECIALTY_IDS } = require('./lib/categories');
const { pickByPopularity, diversityFloor, buildHourWindows, hourRecencyWindows, selectWithinBroadcastWindow } = require('./lib/select');
const { getProjectDir, monthFolderFromRunId } = require('./lib/project-path');
const { getRejectReason, filterClips } = require('./lib/filter');
const { createTwitchClient, sleep } = require('./lib/twitch-api');

// Parse argv positionally-flexible: token is optional (env var preferred) and
// may appear anywhere relative to flags, so `ingest.js runId --hours 72`
// (no token arg) never misparses `--hours` as the token — that exact bug
// silently dropped the requested window back to the 24h default.
const runId = process.argv[2];
const rest = process.argv.slice(3);
let tokenArg;
const flags = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    flags.push(a);
    if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) { flags.push(rest[i + 1]); i++; }
  } else if (tokenArg === undefined) {
    tokenArg = a;
  }
}

require('./lib/env').loadEnv();
const TOKEN = process.env.TWITCH_TOKEN || tokenArg;
if (tokenArg && TOKEN === tokenArg) {
  console.warn('[INGEST] Токен передано через argv — він видимий у process list. Краще: export TWITCH_TOKEN=...');
}

const hoursArg = flags.indexOf('--hours');
const parsedHours = hoursArg >= 0 ? parseInt(flags[hoursArg + 1], 10) : NaN;
const HOURS = Number.isInteger(parsedHours) && parsedHours > 0 ? parsedHours : 24;
const MAX_CANDIDATES = 500;

// One-off per-run exclusion (e.g. `--exclude kaicenat,ishowspeed`) — separate
// from the permanent STREAMER_BLACKLIST in lib/filter.js, which is for
// streamers banned across all future episodes.
const excludeArg = flags.indexOf('--exclude');
const EXCLUDE_BROADCASTERS = new Set(
  excludeArg >= 0 ? flags[excludeArg + 1].toLowerCase().split(',').map(s => s.trim()).filter(Boolean) : []
);

// Ensure month folder exists before creating project dir
const _month = monthFolderFromRunId(runId);
if (_month) fs.mkdirSync(path.join('projects', _month), { recursive: true });
const RUN_DIR = getProjectDir(runId);
const CLIPS_DIR = path.join(RUN_DIR, 'clips');

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const twitch = createTwitchClient(CLIENT_ID, TOKEN);

async function main() {
  const nowMs = Date.now();
  const startedAt = new Date(nowMs - HOURS * 3600 * 1000).toISOString();
  console.log(`[INGEST] runId=${runId} started_at=${startedAt}${HOURS !== 24 ? ` hours=${HOURS}` : ''}`);

  // Page counts scale with window length so longer ranges don't under-sample
  // the pool (fixed at 24h-equivalent 3/1 pages would starve recency windows).
  const JCIRL_PAGES = Math.min(15, Math.ceil(3 * HOURS / 24));
  const OTHER_PAGES = Math.min(6, Math.ceil(HOURS / 24));

  // Core categories — lib/categories.js
  const CORE = CORE_CATEGORIES;
  const CORE_IDS = new Set(CORE.map(c => c.id));

  // Dynamic categories: top-10 by popularity, excluding core and banlist (fetches top-50 to find 10)
  const BAN_KEYWORDS = ['slots', 'casino', 'gambling', 'betting', 'poker', 'tarkov', 'overwatch', 'marvel rivals', 'sports betting', 'dark and darker', 'path of exile'];
  console.log('[INGEST] Fetching top games...');
  const topGames = await twitch.getTopGames();
  const dynamic = topGames
    .filter(g => !CORE_IDS.has(g.id) && !BAN_KEYWORDS.some(k => g.name.toLowerCase().includes(k)))
    .slice(0, 10)
    .map(g => ({ id: g.id, name: g.name }));

  console.log(`[INGEST] Dynamic categories (${dynamic.length}): ${dynamic.map(d => d.name).join(', ')}`);

  const allCategories = [...CORE, ...dynamic];
  const allClips = [];
  const seen = new Set();

  const jcIrlCursors = {};
  for (const cat of allCategories) {
    const pages = JCIRL_IDS.has(cat.id) ? JCIRL_PAGES : OTHER_PAGES;
    console.log(`[INGEST] Fetching ${cat.name} (${cat.id}), ${pages} pages...`);
    try {
      const { clips, nextCursor } = await twitch.fetchClipsForCategory(cat.id, startedAt, pages);
      if (JCIRL_IDS.has(cat.id)) jcIrlCursors[cat.id] = nextCursor;
      let added = 0;
      for (const c of clips) {
        if (EXCLUDE_BROADCASTERS.has((c.broadcaster_name || '').toLowerCase())) continue;
        if (!seen.has(c.id)) {
          seen.add(c.id);
          const login = c.url ? (new URL(c.url).pathname.split('/').filter(Boolean)[0] || undefined) : undefined;
          allClips.push({ ...c, game_id: cat.id, game_name: cat.name, ...(login ? { broadcaster_login: login } : {}) });
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

  updateState(RUN_DIR, s => {
    s.counts.raw = allClips.length;
    s.stages.ingest = 'done';
    s.stages.filter = 'running';
  });

  console.log('[INGEST] Done. raw-clips.json saved.');

  // ---- FILTER ----
  console.log('[FILTER] Starting...');
  const { filtered, rejected, vtuberBroadcasterIds } = await filterClips(allClips, twitch);
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
        try { page = await twitch.fetchClipsPage(gameId, startedAt, cursor); }
        catch(e) { console.error(`  [TOPUP ERROR] ${e.message}`); break; }
        cursor = page.pagination?.cursor || null;
        pages++;
        for (const c of (page.data || [])) {
          if (seenTopup.has(c.id)) continue;
          if (EXCLUDE_BROADCASTERS.has((c.broadcaster_name || '').toLowerCase())) continue;
          seenTopup.add(c.id);
          const clip = { ...c, game_id: gameId, game_name: JCIRL_TOPUP_NAMES[gameId] };
          const rejectReason = getRejectReason(clip, vtuberBroadcasterIds);
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

  updateState(RUN_DIR, s => {
    s.counts.filtered = filtered.length;
    s.stages.filter = 'done';
    s.stages.select = 'running';
  });

  // ---- SELECT ----
  console.log('[SELECT] Picking candidates by popularity...');

  // maxClipCandidates: кожен бакет капується окремо, щоб gaming кліпи з нижчим view_count
  // не витіснялися JC/IRL кліпами при спільному сортуванні.
  const jcIrlFiltered  = filtered.filter(c => JCIRL_IDS.has(c.game_id));
  const gamingFiltered = filtered.filter(c => !JCIRL_IDS.has(c.game_id) && !SPECIALTY_IDS.has(c.game_id));

  const jcIrlPool = jcIrlFiltered.length > MAX_CANDIDATES
    ? [...jcIrlFiltered].sort((a, b) => b.view_count - a.view_count).slice(0, MAX_CANDIDATES)
    : jcIrlFiltered;
  const gamingPool = gamingFiltered.length > MAX_CANDIDATES
    ? [...gamingFiltered].sort((a, b) => b.view_count - a.view_count).slice(0, MAX_CANDIDATES)
    : gamingFiltered;

  console.log(`[SELECT] Pools — JC/IRL=${jcIrlPool.length}, Gaming=${gamingPool.length}`);

  // JC/IRL: 80 по popularity (max 5/streamer) + 20 diversity-floor
  // (гарантує ≥1 кліп кожному unrepresented стрімеру, решта по popularity).
  // Fallback: якщо diversity pool вичерпаний — доповнюємо з решти пулу по popularity до 100.
  const jcIrl80 = pickByPopularity(jcIrlPool, { limit: 80, maxPerStreamer: 5 });
  const jcIrl20 = diversityFloor(jcIrlPool, jcIrl80, 20);
  let jcIrlPick = [...jcIrl80, ...jcIrl20];
  if (jcIrlPick.length < 100) {
    const pickedIds = new Set(jcIrlPick.map(c => c.id));
    const fallback  = [...jcIrlPool]
      .filter(c => !pickedIds.has(c.id))
      .sort((a, b) => b.view_count - a.view_count)
      .slice(0, 100 - jcIrlPick.length);
    jcIrlPick = [...jcIrlPick, ...fallback];
  }

  // Gaming: 50 кліпів одразу — GAMING_SCREEN перевіряє всі за один прохід.
  // ~50% відсіву очікується, тому беремо вдвічі більше від мінімуму (20).
  let gamingPick = pickByPopularity(gamingPool, { limit: 50, maxPerStreamer: 5, maxPerGame: 5 });

  // Recency compensation for custom --hours N > 24: adds clips on top of the
  // base+diversity-floor pick, favoring windows closer to "now" that haven't
  // had as much time to accumulate views. No-op (empty windows) when N<=24.
  const hourWindows = buildHourWindows(HOURS);
  let jcIrlRecency = [];
  let gamingRecency = [];
  if (hourWindows.length > 0) {
    jcIrlRecency = hourRecencyWindows(jcIrlPool, jcIrlPick, nowMs, hourWindows, 'jcirlSlots');
    jcIrlPick = [...jcIrlPick, ...jcIrlRecency];
    gamingRecency = hourRecencyWindows(gamingPool, gamingPick, nowMs, hourWindows, 'gamingSlots');
    gamingPick.push(...gamingRecency);
    console.log(`[SELECT] Recency compensation (--hours ${HOURS}): +${jcIrlRecency.length} JC/IRL, +${gamingRecency.length} Gaming`);
  }

  // created_at guarantees the clip resource was made inside the window, but
  // not that the highlighted moment actually aired inside it (long-running
  // broadcast that started earlier, or a clip cut later from an old VOD).
  // Reject those by real broadcast time and backfill from the same pool.
  const windowStartMs = new Date(startedAt).getTime();
  const jcIrlBefore = jcIrlPick.length;
  const gamingBefore = gamingPick.length;
  jcIrlPick = await selectWithinBroadcastWindow(jcIrlPick, jcIrlPool, windowStartMs, twitch);
  gamingPick = await selectWithinBroadcastWindow(gamingPick, gamingPool, windowStartMs, twitch);
  const jcIrlDropped = jcIrlBefore - jcIrlPick.length;
  const gamingDropped = gamingBefore - gamingPick.length;
  if (jcIrlDropped > 0 || gamingDropped > 0) {
    console.log(`[SELECT] Broadcast-window check: dropped ${jcIrlDropped} JC/IRL + ${gamingDropped} Gaming clips whose real broadcast predates the window (backfilled where the pool allowed)`);
  }

  const downloadedIds = new Set();
  let toDownload = [];
  for (const c of [...jcIrlPick, ...gamingPick]) {
    if (!downloadedIds.has(c.id)) { downloadedIds.add(c.id); toDownload.push(c); }
  }

  const jcIrlCount2  = toDownload.filter(c => JCIRL_IDS.has(c.game_id)).length;
  const gamingCount2 = toDownload.filter(c => !JCIRL_IDS.has(c.game_id) && !SPECIALTY_IDS.has(c.game_id)).length;
  const jcIrlTarget = HOURS === 24 ? '100' : `100+recency`;
  const gamingTarget = HOURS === 24 ? '50' : '50+recency';
  console.log(`[SELECT] ${toDownload.length} candidates — JC/IRL=${jcIrlCount2} (target ${jcIrlTarget}), Gaming=${gamingCount2} (target ${gamingTarget}; GAMING_SCREEN відсіює ~50%)`);

  fs.writeFileSync(path.join(CLIPS_DIR, 'prescore-candidates.json'), JSON.stringify(toDownload, null, 2));

  updateState(RUN_DIR, s => {
    s.stages.select = 'done';
    s.stages.download = 'running';
    // Persisted so any later stage that pulls in more candidates from the
    // filtered pool (e.g. gaming-screen.js backfill rounds) can re-run the
    // same broadcast-window check instead of silently skipping it.
    s.ingestWindowStart = new Date(windowStartMs).toISOString();
  });

  console.log('[SELECT] Done. prescore-candidates.json saved.');
  console.log('\nTop 10 by views:');
  [...toDownload].sort((a, b) => b.view_count - a.view_count).slice(0, 10).forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.broadcaster_name} — "${c.title.slice(0, 60)}" (${c.game_name}, ${c.view_count} views)`);
  });
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
