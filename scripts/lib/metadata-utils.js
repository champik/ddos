'use strict';

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

const SPECIALTY = {
  '26936':     ['TwitchMusic', 'MusicStream'],
  '509667':    ['CookingStream', 'FoodTwitch'],
  '509671':    ['FitnessTwitch'],
  '116747788': ['HotTubStream'],
  '417752':    ['TwitchPodcast'],
};
const CORE_IDS = new Set(['509658', '509672', ...Object.keys(SPECIALTY)]);

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
    if (c.broadcaster_name && !streamerTags.includes(c.broadcaster_name))
      streamerTags.push(c.broadcaster_name);
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

function buildShortsTags(clipId, byId) {
  const c = byId[clipId];
  const streamerTag = c?.broadcaster_name ? '#' + c.broadcaster_name.replace(/[^a-zA-Z0-9]/g, '') : null;
  const categoryTag = c?.game_name ? '#' + c.game_name.replace(/[^a-zA-Z0-9]/g, '') : null;
  const descriptionHashtags = [
    ...(streamerTag ? [streamerTag] : []),
    ...(categoryTag ? [categoryTag] : []),
    '#twitch', '#stream', '#live',
  ];

  const specific = [...descriptionHashtags, '#DailyDoseOfStream', '#TwitchClips', '#TwitchHighlights', '#Shorts'];
  if (c) {
    const gid = String(c.game_id || '');
    if (SPECIALTY[gid]) {
      for (const t of SPECIALTY[gid]) specific.push('#' + t);
    } else if (gid && !CORE_IDS.has(gid) && c.game_name) {
      specific.push('#' + sanitizeGameTag(c.game_name), '#Gaming', '#TwitchGaming');
    }
  }
  const general = [
    '#TwitchShorts', '#StreamerMoments', '#FunnyMoments', '#TwitchMoments',
    '#StreamHighlights', '#TwitchCompilation', '#BestMoments',
    '#StreamClips', '#TwitchFunny', '#JustChatting', '#LiveStreaming',
    '#TwitchHighlight', '#TwitchClip', '#ClipOfTheDay', '#TwitchCommunity',
    '#StreamMoment', '#TwitchStream', '#ContentCreator', '#ShortsVideo',
    '#TwitchFails', '#DailyClips', '#TopClips', '#TwitchTV', '#Streaming',
  ];
  const candidates = [...new Set([...specific, ...general])];
  const tags = [];
  let len = 0;
  for (const t of candidates) {
    const bare = t.replace(/^#/, '');
    const add = (tags.length > 0 ? 1 : 0) + bare.length;
    if (len + add > 500) break;
    tags.push(t);
    len += add;
  }
  return { descriptionHashtags, tags };
}

module.exports = { fmt, sanitizeGameTag, SPECIALTY, CORE_IDS, buildVideoTags, buildShortsTags };
