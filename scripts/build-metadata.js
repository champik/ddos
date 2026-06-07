'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node build-metadata.js <projectDir>'); process.exit(1); }

const plan     = JSON.parse(fs.readFileSync(path.join(projectDir, 'edit/episode-plan.json'), 'utf8'));
const scored   = JSON.parse(fs.readFileSync(path.join(projectDir, 'clips/scored-clips.json'), 'utf8'));
const dlPath   = path.join(projectDir, 'clips/downloaded-clips.json');
const dl       = fs.existsSync(dlPath) ? JSON.parse(fs.readFileSync(dlPath, 'utf8')) : [];
const byId     = Object.fromEntries([...dl, ...scored].map(c => [c.id, c]));
const metaPath = path.join(projectDir, 'exports/metadata.json');

// Read Claude-generated metadata if present, otherwise start with empty shell
let meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};

// ── helpers ───────────────────────────────────────────────────────────────────

function getDur(clipId) {
  const p = path.join(projectDir, 'processed', clipId, 'clean.mp4');
  if (!fs.existsSync(p)) return 0;
  try {
    return parseFloat(execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${p}"`).toString().trim()) || 0;
  } catch { return 0; }
}

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

// ── tag config ────────────────────────────────────────────────────────────────

// game_id → extra tags for specialty categories (JC/IRL handled via base tags)
const SPECIALTY = {
  '26936':     ['TwitchMusic', 'MusicStream'],
  '509667':    ['CookingStream', 'FoodTwitch'],
  '509671':    ['FitnessTwitch'],
  '116747788': ['HotTubStream'],
  '417752':    ['TwitchPodcast'],
};
// IDs that don't generate a gaming tag
const CORE_IDS = new Set(['509658', '509672', ...Object.keys(SPECIALTY)]);

// clips actually in the episode, in timeline order
const ALL_CLIP_IDS = plan.groups.flatMap(g => g.clipIds);

// ── tag builders ──────────────────────────────────────────────────────────────

function buildVideoTags() {
  const base = [
    'DailyDoseOfStream', 'TwitchClips', 'TwitchHighlights', 'TwitchMoments',
    'StreamHighlights', 'Twitch', 'FunnyMoments', 'BestMoments', 'StreamerMoments',
    'ClipCompilation', 'TwitchCompilation', 'DailyHighlights', 'JustChatting', 'IRL', 'Streaming',
  ];
  const streamerTags = [], specialtyTags = [], gamingTags = [];
  let hasGaming = false;

  for (const id of ALL_CLIP_IDS) {
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
  // order: base → streamers (appearance order) → specialty → gaming
  return [...base, ...streamerTags, ...specialtyTags, ...gamingBase, ...gamingTags].slice(0, 30);
}

function buildShortsTags(clipId) {
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

function buildXEpisodeCaption() {
  const title = meta.selectedTitle || (meta.titleOptions && meta.titleOptions[0]) || '';
  if (!title) return '';
  return title + ' #Twitch #TwitchClips';
}

function buildXShortCaption(clipId) {
  const s = (meta.shortsMetadata || []).find(x => x.clipId === clipId);
  if (!s) return '';
  return (s.title || '') + ' #Twitch';
}

function buildHashtags() {
  const base = '#DailyDoseOfStream #TwitchClips #TwitchHighlights #Twitch #StreamHighlights #FunnyMoments #StreamerMoments';
  const streamers = [];
  for (const id of ALL_CLIP_IDS) {
    const name = byId[id]?.broadcaster_name;
    if (name && !streamers.includes(name)) streamers.push(name);
  }
  const top5 = streamers.slice(0, 5).map(s => '#' + s.replace(/\s/g, '')).join(' ');
  return base + (top5 ? ' ' + top5 : '');
}

// ── chapters (broadcaster_name per clip, new chapter on streamer change) ───────

const INTRO_DUR     = 1.25;
const reconnectPath = path.join(projectDir, 'edit', 'reconnecting.mp4');
const RECONNECT_DUR = (() => {
  if (!fs.existsSync(reconnectPath)) return 1.0;
  try { return parseFloat(execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${reconnectPath}"`).toString().trim()) || 1.0; }
  catch { return 1.0; }
})();

const chapters = [];
let offset      = INTRO_DUR;
let lastStreamer = null;

const chapterDescriptions = meta.chapterDescriptions || {};

for (let gi = 0; gi < plan.groups.length; gi++) {
  const g = plan.groups[gi];
  for (const clipId of g.clipIds) {
    const streamer = byId[clipId]?.broadcaster_name || g.label;
    if (streamer !== lastStreamer) {
      const t = chapters.length === 0 ? 0 : Math.round(offset);
      const desc = chapterDescriptions[clipId];
      const label = desc || streamer;
      chapters.push({ t, label });
      lastStreamer = streamer;
    }
    offset += getDur(clipId);
  }
  if (gi < plan.groups.length - 1) offset += RECONNECT_DUR;
}

const chaptersStr = chapters.map(c => fmt(c.t) + ' ' + c.label).join('\n');

// ── assemble ──────────────────────────────────────────────────────────────────

meta.tags = buildVideoTags();
meta.xEpisodeCaption = buildXEpisodeCaption();

// Replace timecodes + hashtags (strip old ones first, then append fresh)
if (meta.description) {
  const cutAt = meta.description.indexOf('\n\n00:00');
  const base = cutAt !== -1 ? meta.description.slice(0, cutAt) : meta.description;
  meta.description = base + '\n\n' + chaptersStr + '\n\n' + buildHashtags();
}

// Enrich each Short's hashtags based on its actual clip
if (Array.isArray(meta.shortsMetadata)) {
  meta.shortsMetadata = meta.shortsMetadata.map(s => ({
    ...s,
    ...buildShortsTags(s.clipId),
    xCaption: buildXShortCaption(s.clipId),
  }));
}

fs.mkdirSync(path.join(projectDir, 'exports'), { recursive: true });
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

console.log('[OK] metadata.json written');
console.log(`\nTags (${meta.tags.length}): ${meta.tags.join(', ')}`);
console.log('\nChapters:\n' + chaptersStr);
if (Array.isArray(meta.titleOptions) && meta.titleOptions.length > 0) {
  console.log('\nThumbnail captions (pipe-style):');
  meta.titleOptions.forEach((t, i) => console.log(`  [${i+1}] ${t}`));
}
