'use strict';
// filter.js — FILTER-stage rules (single source of truth). Used by ingest.js's
// main pass, its JC/IRL topup loop, and any future manual re-select so the
// rules never drift between call sites.

const ORG_BLACKLIST = new Set([
  // Esports tournament orgs
  'esl_csgo','eslcs','eslcsb','blasttv','pgl','riotgames','valorant','esl_dota2',
  'weplay_esports','faceit','dreamhack','esltv','iem',
  // Official broadcasters / media (not individual streamers)
  'espn','espn2','nba','nfl','mlb','nhl','ufc',
  'cnn','bbcnews','skynews',
  'twitch','twitchgaming','twitchrivals',
  'gamespot','ign','kotaku',
  'lolesports','lcs','lec','lck','lpl',
  'dota2ti','pgl_dota2','epicenter_cs',
  'overwatchleague','callofduty','fifa','pubg_battlegrounds',
]);
const STREAMER_BLACKLIST = new Set(['lyasyaa', 'qoqsik', 'vedal987', 'miladeva', 'winningbikini', 'panterochka_', 'lily_off_valley']);
const RU_KEYWORDS = ['русский','россия','russian','путін','рф'];
const TOURNAMENT_KEYWORDS = [' major',' grand final','championship',' tournament','qualifier'];
const BANNED_GAMES = ['slots','casino','gambling','betting','poker','tarkov','overwatch','marvel rivals','sports betting','dark and darker','path of exile'];

function getRejectReason(clip, vtuberBroadcasterIds) {
  const lang = (clip.language || '').toLowerCase();
  const title = (clip.title || '').toLowerCase();
  const broadcaster = (clip.broadcaster_name || '').toLowerCase();
  const gameName = (clip.game_name || '').toLowerCase();

  if (lang !== 'en') return 'non_english';
  if (RU_KEYWORDS.some(k => title.includes(k))) return 'ru_keyword';
  if (STREAMER_BLACKLIST.has(broadcaster)) return 'streamer_blacklist';
  if (ORG_BLACKLIST.has(broadcaster)) return 'official_broadcaster';
  if (vtuberBroadcasterIds.has(clip.broadcaster_id)) return 'vtuber';
  if (TOURNAMENT_KEYWORDS.some(k => title.includes(k))) return 'tournament_event';
  if (BANNED_GAMES.some(k => gameName.includes(k))) return 'banned_game';
  if (clip.duration < 6 || clip.duration > 90) return 'duration';
  return null;
}

// Fetches VTuber tags for every clip's broadcaster and splits clips into
// filtered/rejected using getRejectReason. Returns { filtered, rejected, vtuberBroadcasterIds }.
async function filterClips(clips, twitchClient) {
  console.log('[FILTER] Fetching channel tags to detect VTubers...');
  const vtuberBroadcasterIds = await twitchClient.fetchVtuberBroadcasterIds(clips.map(c => c.broadcaster_id));
  console.log(`  [FILTER] VTubers detected: ${vtuberBroadcasterIds.size}`);

  const filtered = [];
  const rejected = [];
  for (const clip of clips) {
    const rejectReason = getRejectReason(clip, vtuberBroadcasterIds);
    if (rejectReason) rejected.push({ ...clip, rejectReason });
    else filtered.push(clip);
  }

  return { filtered, rejected, vtuberBroadcasterIds };
}

module.exports = { ORG_BLACKLIST, STREAMER_BLACKLIST, RU_KEYWORDS, TOURNAMENT_KEYWORDS, BANNED_GAMES, getRejectReason, filterClips };
