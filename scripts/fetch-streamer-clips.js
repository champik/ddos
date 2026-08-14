#!/usr/bin/env node
// DDOS Pipeline — EXTRA STREAMER CLIPS (one-off addition, requested per-run via /run args)
// Fetches ALL clips for specific broadcasters in the ingest window, above a view_count
// floor, and merges them into this run's candidate pool on top of the normal SELECT
// quotas (diversity floor / max-per-streamer caps don't apply to this pool — the whole
// point is "take everything", not a ranked pick).
// Usage: node scripts/fetch-streamer-clips.js <runId> --logins ishowspeed,kaicenat --min-views 1000

const fs = require('fs');
const path = require('path');
const { readJson, updateState } = require('./lib/state');
const { JCIRL_IDS } = require('./lib/categories');
const { getProjectDir } = require('./lib/project-path');
const { getRejectReason } = require('./lib/filter');
const { createTwitchClient, fetchAppAccessToken, sleep } = require('./lib/twitch-api');

const runId = process.argv[2];
const rest = process.argv.slice(3);
function flagValue(name, def) {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : def;
}

const LOGINS = flagValue('--logins', '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const MIN_VIEWS = parseInt(flagValue('--min-views', '1000'), 10);

require('./lib/env').loadEnv();
const RUN_DIR = getProjectDir(runId);
const CLIPS_DIR = path.join(RUN_DIR, 'clips');

async function main() {
  if (LOGINS.length === 0) { console.error('[EXTRA] No --logins given.'); process.exit(1); }

  const state = readJson(path.join(RUN_DIR, 'state.json'));
  const startedAt = state.ingestWindowStart;
  if (!startedAt) { console.error('[EXTRA] state.ingestWindowStart missing — run ingest.js (SELECT stage) first.'); process.exit(1); }

  const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
  const TOKEN = process.env.TWITCH_TOKEN || await fetchAppAccessToken(CLIENT_ID, process.env.TWITCH_CLIENT_SECRET);
  const twitch = createTwitchClient(CLIENT_ID, TOKEN);

  console.log(`[EXTRA] logins=${LOGINS.join(',')} minViews=${MIN_VIEWS} startedAt=${startedAt}`);

  const idMap = await twitch.getUsersByLogin(LOGINS);
  const missing = LOGINS.filter(l => !idMap.has(l));
  if (missing.length) console.warn(`[EXTRA] [WARN] Unknown Twitch login(s), skipped: ${missing.join(', ')}`);

  let allClips = [];
  for (const login of LOGINS) {
    const id = idMap.get(login);
    if (!id) continue;
    console.log(`[EXTRA] Fetching clips for ${login} (${id})...`);
    const clips = await twitch.fetchClipsForBroadcaster(id, startedAt);
    console.log(`  → ${clips.length} clips in window`);
    allClips.push(...clips.map(c => ({ ...c, broadcaster_name: c.broadcaster_name || login })));
    await sleep(150);
  }

  // Above-floor filter first — cheapest cut, avoids wasting VTuber/game lookups on clips we'll drop anyway.
  const aboveFloor = allClips.filter(c => (c.view_count || 0) >= MIN_VIEWS);
  console.log(`[EXTRA] ${aboveFloor.length}/${allClips.length} clips have view_count >= ${MIN_VIEWS}`);

  const gameIds = [...new Set(aboveFloor.map(c => c.game_id).filter(Boolean))];
  const gameNames = await twitch.getGamesByIds(gameIds);
  const vtuberIds = await twitch.fetchVtuberBroadcasterIds(aboveFloor.map(c => c.broadcaster_id));

  const withGameName = aboveFloor.map(c => ({ ...c, game_name: gameNames.get(c.game_id) || c.game_name || 'Unknown' }));

  const rejected = [];
  const passed = [];
  for (const clip of withGameName) {
    const reason = getRejectReason(clip, vtuberIds);
    if (reason) rejected.push({ ...clip, rejectReason: reason });
    else passed.push(clip);
  }
  console.log(`[EXTRA] ${passed.length} passed standard filter, ${rejected.length} rejected (${rejected.map(r => r.rejectReason).join(', ')})`);

  // Dedup against clips already picked by the normal SELECT stage.
  const prescorePath = path.join(CLIPS_DIR, 'prescore-candidates.json');
  const prescore = readJson(prescorePath);
  const existingIds = new Set(prescore.map(c => c.id));
  const newOnes = passed.filter(c => !existingIds.has(c.id));
  console.log(`[EXTRA] ${newOnes.length} new (${passed.length - newOnes.length} already in candidate pool)`);

  // Mark so downstream stages/editorial UI can tell these apart from the ranked picks.
  const tagged = newOnes.map(c => ({ ...c, _extraStreamerAdd: true }));

  const mergedPrescore = [...prescore, ...tagged];
  fs.writeFileSync(prescorePath, JSON.stringify(mergedPrescore, null, 2));

  const filteredPath = path.join(CLIPS_DIR, 'filtered-clips.json');
  const filtered = readJson(filteredPath);
  fs.writeFileSync(filteredPath, JSON.stringify([...filtered, ...tagged], null, 2));

  const rawPath = path.join(CLIPS_DIR, 'raw-clips.json');
  const raw = readJson(rawPath);
  const rawSeen = new Set(raw.map(c => c.id));
  fs.writeFileSync(rawPath, JSON.stringify([...raw, ...withGameName.filter(c => !rawSeen.has(c.id))], null, 2));

  updateState(RUN_DIR, s => {
    s.counts.filtered = (s.counts.filtered || 0) + tagged.length;
    s.stages.extra_streamers = 'done';
  });

  const jcIrlCount = tagged.filter(c => JCIRL_IDS.has(c.game_id)).length;
  console.log(`[EXTRA] Added ${tagged.length} clips to prescore-candidates.json (JC/IRL=${jcIrlCount}, Gaming=${tagged.length - jcIrlCount})`);
  tagged.sort((a, b) => b.view_count - a.view_count).forEach(c => {
    console.log(`  ${c.broadcaster_name} — "${(c.title || '').slice(0, 60)}" (${c.game_name}, ${c.view_count} views)`);
  });
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
