#!/usr/bin/env node
// DDOS Pipeline — INGEST + FILTER + SELECT (month mode, recency-compensation)
// Usage: node scripts/ingest-month.js <runId> --started-at <ISO> --ended-at <ISO>

'use strict';

const fs   = require('fs');
const path = require('path');
const { updateState } = require('./lib/state');
const { CORE_CATEGORIES, JCIRL_IDS, SPECIALTY_IDS } = require('./lib/categories');
const { filterClips, BANNED_GAMES } = require('./lib/filter');
const { createTwitchClient, sleep } = require('./lib/twitch-api');
const { pickByPopularity, enrichBroadcastTimes } = require('./lib/select');
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

const twitch = createTwitchClient(CLIENT_ID, TOKEN);

// lib/twitch-api.js's fetchClipsForCategory only bounds the window by
// started_at (open-ended "since X ago"); month mode needs a closed
// [started_at, ended_at] range, so pagination stays local here — but it
// reuses twitch.httpsGet for the actual HTTP+retry/backoff logic instead of
// hand-copying it (that copy had already drifted from the shared client:
// missing the retry-after header fallback on 429s).
async function fetchClipsPage(gameId, after) {
  let url = `https://api.twitch.tv/helix/clips?game_id=${gameId}&started_at=${encodeURIComponent(STARTED_AT)}&ended_at=${encodeURIComponent(ENDED_AT)}&first=100`;
  if (after) url += `&after=${after}`;
  return twitch.httpsGet(url);
}

async function fetchClipsForCategory(gameId, pages) {
  const clips = [];
  let cursor = null;
  for (let i = 0; i < pages; i++) {
    const page = await fetchClipsPage(gameId, cursor);
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

// Diversity add-on: 1 clip per streamer not yet represented. Intentionally
// NOT lib/select.js's diversityFloor (which guarantees 1/streamer, then fills
// the rest of the quota by popularity with no per-streamer cap) — month mode
// uses a strict add-on instead of a floor (run-month skill: "Diversity floor:
// ✗ (замінено diversity-добавкою)").
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

  console.log('[INGEST-MONTH] Fetching top games for dynamic categories...');
  const topGames = await twitch.getTopGames();
  const CORE_IDS = new Set(CORE_CATEGORIES.map(c => c.id));
  const dynamic = topGames
    .filter(g => !CORE_IDS.has(g.id) && !BANNED_GAMES.some(k => g.name.toLowerCase().includes(k)))
    .slice(0, 10)
    .map(g => ({ id: g.id, name: g.name }));

  console.log(`[INGEST-MONTH] Dynamic categories (${dynamic.length}): ${dynamic.map(d => d.name).join(', ')}`);

  const allCategories = [...CORE_CATEGORIES, ...dynamic];
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

  // ---- FILTER (same rules as regular /run — lib/filter.js) ----
  console.log('[FILTER] Starting...');
  const { filtered, rejected } = await filterClips(allClips, twitch);

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

  // Enrich with VOD broadcast times (shared — lib/select.js)
  await enrichBroadcastTimes(toDownload, twitch);

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
