'use strict';
const { streamerTag } = require('./display-name');
const { NON_GAMING_IDS } = require('./categories');

function fmt(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function sanitizeGameTag(name) {
  return name.replace(/[^a-zA-Z0-9\s]/g, '').trim()
    .split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

// Маппінг game_id → теги. Містить і категорії поза Core (Cooking, Fitness, Podcast),
// бо вони можуть зʼявитись через dynamic top-20 ingest.
const SPECIALTY = {
  '26936':     ['TwitchMusic', 'MusicStream'],
  '509667':    ['CookingStream', 'FoodTwitch'],
  '509671':    ['FitnessTwitch'],
  '116747788': ['HotTubStream'],
  '417752':    ['TwitchPodcast'],
};
// Non-gaming ids come from lib/categories.js (single source of truth) so a
// new dynamic specialty category added there doesn't silently get tagged as
// Gaming here just because SPECIALTY/CORE_IDS weren't updated in lockstep.
const CORE_IDS = NON_GAMING_IDS;

function buildVideoTags(allClipIds, byId) {
  const base = [
    'DailyDoseOfStream', 'TwitchClips', 'TwitchHighlights', 'TwitchMoments',
    'StreamHighlights', 'Twitch', 'FunnyMoments', 'BestMoments', 'StreamerMoments',
    'ClipCompilation', 'TwitchCompilation', 'DailyHighlights', 'JustChatting', 'IRL', 'Streaming',
  ];
  const streamerTags = [], specialtyTags = [], gamingTags = [];
  let hasGaming = false;

  for (const id of allClipIds) {
    const c = byId[id];
    if (!c) continue;
    const sTag = c ? streamerTag(c) : null;
    if (sTag && !streamerTags.includes(sTag))
      streamerTags.push(sTag);
    const gid = String(c.game_id || '');
    if (SPECIALTY[gid]) {
      for (const t of SPECIALTY[gid])
        if (!specialtyTags.includes(t)) specialtyTags.push(t);
    } else if (gid && !CORE_IDS.has(gid) && c.game_name) {
      hasGaming = true;
      const tag = sanitizeGameTag(c.game_name);
      if (tag && !gamingTags.includes(tag)) gamingTags.push(tag);
    }
  }

  const gamingBase = hasGaming ? ['Gaming', 'TwitchGaming', 'GameClips'] : [];
  return [...base, ...streamerTags, ...specialtyTags, ...gamingBase, ...gamingTags].slice(0, 30);
}

// Хештеги для опису лонгформа. Перші 3 показуються над заголовком відео,
// тому туди йдуть топ-2 стрімери (клікабельні, мають пошуковий трафік) + #TwitchClips.
function buildDescriptionHashtags(allClipIds, byId) {
  const streamers = [];
  for (const id of allClipIds) {
    const c = byId[id];
    const tag = c ? streamerTag(c) : null;
    if (tag && !streamers.includes(tag)) streamers.push(tag);
  }
  const streamerTags = streamers.slice(0, 5).map(s => '#' + s.replace(/[^a-zA-Z0-9_]/g, ''));
  const lead = [...streamerTags.slice(0, 2), '#TwitchClips'];
  const rest = [
    '#TwitchHighlights', '#DailyDoseOfStream', '#Twitch',
    '#StreamHighlights', '#FunnyMoments', '#StreamerMoments',
    ...streamerTags.slice(2),
  ];
  return [...lead, ...rest].join(' ');
}

module.exports = { fmt, sanitizeGameTag, SPECIALTY, CORE_IDS, buildVideoTags, buildDescriptionHashtags };
