'use strict';
// select.js — чисті функції відбору кандидатів для SELECT-стадії.
// Без velocity: тільки popularity (view_count) + diversity floor.
// Обґрунтування — docs/superpowers/specs/2026-06-16-select-stage-rebalance-design.md


function pickByPopularity(pool, { limit, maxPerStreamer = null, maxPerGame = null, alreadySelected = [] }) {
  const selectedIds = new Set(alreadySelected.map(c => c.id));
  const streamerCounts = new Map();
  const gameCounts = new Map();

  for (const c of alreadySelected) {
    if (maxPerStreamer) streamerCounts.set(c.broadcaster_name, (streamerCounts.get(c.broadcaster_name) || 0) + 1);
    if (maxPerGame) gameCounts.set(c.game_id, (gameCounts.get(c.game_id) || 0) + 1);
  }

  const ranked = [...pool].sort((a, b) => b.view_count - a.view_count);
  const result = [];

  for (const c of ranked) {
    if (result.length >= limit) break;
    if (selectedIds.has(c.id)) continue;
    if (maxPerStreamer && (streamerCounts.get(c.broadcaster_name) || 0) >= maxPerStreamer) continue;
    if (maxPerGame && (gameCounts.get(c.game_id) || 0) >= maxPerGame) continue;

    selectedIds.add(c.id);
    if (maxPerStreamer) streamerCounts.set(c.broadcaster_name, (streamerCounts.get(c.broadcaster_name) || 0) + 1);
    if (maxPerGame) gameCounts.set(c.game_id, (gameCounts.get(c.game_id) || 0) + 1);
    result.push(c);
  }

  return result;
}

// Diversity floor: гарантує 1 слот кожному unrepresented стрімеру,
// решта quota слотів заповнюється з того ж пулу по popularity (можна кілька/стрімер).
// Якщо unrepresented > quota — беремо топ-quota за best view_count стрімера.
function diversityFloor(pool, alreadySelected, quota) {
  const representedStreamers = new Set(alreadySelected.map(c => c.broadcaster_name));

  // Пул кліпів від стрімерів що не потрапили в alreadySelected
  const diversityPool = [...pool]
    .filter(c => !representedStreamers.has(c.broadcaster_name))
    .sort((a, b) => b.view_count - a.view_count);

  if (diversityPool.length === 0) return [];

  const result = [];
  const selectedIds = new Set();

  // Крок 1: гарантований 1 слот кожному unrepresented стрімеру (за best clip desc)
  const bestByStreamer = new Map();
  for (const c of diversityPool) {
    if (!bestByStreamer.has(c.broadcaster_name)) bestByStreamer.set(c.broadcaster_name, c);
  }
  const guaranteed = [...bestByStreamer.values()].sort((a, b) => b.view_count - a.view_count);
  for (const c of guaranteed) {
    if (result.length >= quota) break;
    result.push(c);
    selectedIds.add(c.id);
  }

  // Крок 2: заповнюємо решту quota по popularity з того ж пулу (без ліміту на стрімера)
  for (const c of diversityPool) {
    if (result.length >= quota) break;
    if (selectedIds.has(c.id)) continue;
    result.push(c);
    selectedIds.add(c.id);
  }

  return result;
}

// Fixed-tail hour windows for custom --hours N ingest ranges (N > 24).
// Anchored to fixed "hours ago" marks (24, 72) rather than scaled proportionally
// to N, mirroring how /run month's day-of-month windows don't scale with month length.
// Design: docs/superpowers/specs/2026-07-07-custom-hours-recency-ingest-design.md
function buildHourWindows(hours) {
  if (hours <= 24) return [];
  const windows = [
    { minHoursAgo: 0,  maxHoursAgo: Math.min(24, hours), jcirlSlots: 15, gamingSlots: 8 },
    { minHoursAgo: 24, maxHoursAgo: Math.min(72, hours), jcirlSlots: 10, gamingSlots: 5 },
  ];
  if (hours > 72) {
    windows.push({ minHoursAgo: 72, maxHoursAgo: hours, jcirlSlots: 5, gamingSlots: 2 });
  }
  return windows;
}

// Recency compensation: per window, pick up to its slot target by popularity,
// excluding clips already in alreadySelected (or picked by an earlier window in
// this same call). slotsKey selects 'jcirlSlots' or 'gamingSlots' from each window.
function hourRecencyWindows(pool, alreadySelected, nowMs, windows, slotsKey) {
  const pickedIds = new Set(alreadySelected.map(c => c.id));
  const result = [];

  for (const w of windows) {
    const slots = w[slotsKey];
    if (!slots) continue;

    const eligible = pool
      .filter(c => !pickedIds.has(c.id))
      .filter(c => {
        const hoursAgo = (nowMs - new Date(c.created_at).getTime()) / 3600000;
        return hoursAgo >= w.minHoursAgo && hoursAgo < w.maxHoursAgo;
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

// Resolves broadcastedAt for one clip from VOD data (video_id + vod_offset),
// falling back to clip.created_at when no VOD is available. Shared by
// SELECT's enrichBroadcastTimes and add-clip.js so both paths compute it
// the same way.
function computeBroadcastedAt(clip, vodCreatedAt) {
  if (vodCreatedAt && clip.vod_offset != null) {
    const candidateMs = new Date(vodCreatedAt).getTime() + clip.vod_offset * 1000;
    return { broadcastedAt: new Date(candidateMs).toISOString(), broadcastedAtSource: 'vod' };
  }
  return { broadcastedAt: clip.created_at, broadcastedAtSource: 'clip' };
}

// Enriches clips in-place with actual broadcast time from VOD data
// (video_id + vod_offset), falling back to clip.created_at when no VOD is
// available. Every code path that produces downloadable candidates (main
// SELECT, recency top-up, any future manual re-select) must call this —
// skipping it silently drops the "VOD" badge in edit.html.
async function enrichBroadcastTimes(clips, twitchClient) {
  const vodIds = clips.filter(c => c.video_id).map(c => c.video_id);
  if (vodIds.length === 0) {
    for (const clip of clips) { clip.broadcastedAt = clip.created_at; clip.broadcastedAtSource = 'clip'; }
    return { vodHits: 0, total: clips.length };
  }

  console.log(`[SELECT] Fetching VOD broadcast times for ${new Set(vodIds).size} unique VODs...`);
  const vodMap = await twitchClient.fetchVodCreatedTimes(vodIds);

  let vodHits = 0;
  for (const clip of clips) {
    if (clip.broadcastedAt) continue; // already enriched (e.g. re-running on a mixed set)
    const { broadcastedAt, broadcastedAtSource } = computeBroadcastedAt(clip, vodMap.get(clip.video_id));
    clip.broadcastedAt = broadcastedAt;
    clip.broadcastedAtSource = broadcastedAtSource;
    if (broadcastedAtSource === 'vod') vodHits++;
  }
  console.log(`[SELECT] Broadcast times: ${vodHits} from VOD, ${clips.length - vodHits} from clip created_at`);
  return { vodHits, total: clips.length };
}

// created_at alone doesn't guarantee the clipped moment happened inside the
// requested ingest window — Twitch only guarantees created_at (when the clip
// resource was made) is inside it, not broadcastedAt (when the highlighted
// moment actually aired). A clip can be cut from a long-running broadcast
// that started before the window, or re-clipped later from an old VOD.
// This rejects any clip whose real broadcast time predates windowStartMs and
// backfills replacements from `pool` by popularity so bucket counts don't
// silently shrink. Safety-capped like GAMING_SCREEN's backfill rounds.
async function selectWithinBroadcastWindow(picked, pool, windowStartMs, twitchClient, maxRounds = 3) {
  let current = [...picked];
  const excludedIds = new Set();

  for (let round = 0; round < maxRounds; round++) {
    await enrichBroadcastTimes(current, twitchClient);

    const withinWindow = [];
    for (const c of current) {
      if (new Date(c.broadcastedAt).getTime() >= windowStartMs) withinWindow.push(c);
      else excludedIds.add(c.id);
    }
    const rejectedCount = current.length - withinWindow.length;
    if (rejectedCount === 0) return withinWindow;

    const usedIds = new Set([...withinWindow.map(c => c.id), ...excludedIds]);
    const replacements = [...pool]
      .filter(c => !usedIds.has(c.id))
      .sort((a, b) => b.view_count - a.view_count)
      .slice(0, rejectedCount);

    if (replacements.length === 0) return withinWindow; // pool exhausted, nothing left to backfill with
    current = [...withinWindow, ...replacements]; // replacements get enriched+checked next round
  }

  // maxRounds exhausted with still-unchecked replacements from the last round —
  // one final enrich+filter pass so we never return a clip that wasn't verified.
  await enrichBroadcastTimes(current, twitchClient);
  return current.filter(c => new Date(c.broadcastedAt).getTime() >= windowStartMs);
}

module.exports = {
  pickByPopularity, diversityFloor, buildHourWindows, hourRecencyWindows,
  enrichBroadcastTimes, computeBroadcastedAt, selectWithinBroadcastWindow,
};
