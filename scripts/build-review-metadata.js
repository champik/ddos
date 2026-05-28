'use strict';
// Builds lightweight metadata for gen-review.js when the full metadata stage hasn't run yet.
// Usage: node scripts/build-review-metadata.js <projectDir>

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node scripts/build-review-metadata.js <projectDir>'); process.exit(1); }

const plan   = JSON.parse(fs.readFileSync(path.join(projectDir, 'edit/episode-plan.json'), 'utf8'));
const scored = JSON.parse(fs.readFileSync(path.join(projectDir, 'clips/scored-clips.json'), 'utf8'));
const byId   = Object.fromEntries(scored.map(c => [c.id, c]));

// ── helpers ───────────────────────────────────────────────────────────────────

function duration(clipId) {
  const file = path.join(projectDir, 'processed', clipId, 'clean.mp4');
  if (!fs.existsSync(file)) return 0;
  const r = spawnSync('ffprobe', ['-v','quiet','-show_entries','format=duration','-of','csv=p=0', file], { encoding: 'utf8' });
  return parseFloat(r.stdout) || 0;
}

function fmt(seconds) {
  const total = Math.floor(seconds);
  return `${String(Math.floor(total / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
}

function reconnectDur() {
  const file = path.join(projectDir, 'edit/reconnecting.mp4');
  if (!fs.existsSync(file)) return 1.0;
  const r = spawnSync('ffprobe', ['-v','quiet','-show_entries','format=duration','-of','csv=p=0', file], { encoding: 'utf8' });
  return parseFloat(r.stdout) || 1.0;
}

function sanitizeGameTag(name) {
  return name.replace(/[^a-zA-Z0-9\s]/g, '').trim()
    .split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

// ── tag config ────────────────────────────────────────────────────────────────

const SPECIALTY = {
  '26936':     ['TwitchMusic', 'MusicStream'],
  '509667':    ['CookingStream', 'FoodTwitch'],
  '509671':    ['FitnessTwitch'],
  '116747788': ['HotTubStream'],
  '417752':    ['TwitchPodcast'],
};
const CORE_IDS = new Set(['509658', '509672', ...Object.keys(SPECIALTY)]);

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
  return [...base, ...streamerTags, ...specialtyTags, ...gamingBase, ...gamingTags].slice(0, 30);
}

function buildShortsTags(clipId) {
  const c = byId[clipId];
  const base = ['#DailyDoseOfStream', '#TwitchClips', '#TwitchHighlights', '#Shorts'];
  if (!c) return base;
  const tags = [...base];
  if (c.broadcaster_name) tags.push('#' + c.broadcaster_name.replace(/\s/g, ''));
  const gid = String(c.game_id || '');
  if (SPECIALTY[gid]) {
    tags.push('#' + SPECIALTY[gid][0]);
  } else if (gid && !CORE_IDS.has(gid) && c.game_name) {
    tags.push('#' + sanitizeGameTag(c.game_name));
  }
  return tags.slice(0, 8);
}

// ── chapters ──────────────────────────────────────────────────────────────────

const rcDur    = reconnectDur();
const chapters = [];
let offset      = 1.25;
let lastStreamer = null;

for (let i = 0; i < plan.groups.length; i++) {
  const g = plan.groups[i];
  for (const clipId of g.clipIds) {
    const streamer = byId[clipId]?.broadcaster_name || g.label;
    if (streamer !== lastStreamer) {
      chapters.push({ t: chapters.length === 0 ? 0 : Math.round(offset), label: streamer });
      lastStreamer = streamer;
    }
    offset += duration(clipId);
  }
  if (i < plan.groups.length - 1) offset += rcDur;
}

if (plan.chillPlan && plan.chillPlan.type !== 'skip') {
  chapters.push({ t: Math.round(offset), label: 'Chill Outro' });
}

const chaptersStr = chapters.map(c => fmt(c.t) + ' ' + c.label).join('\n');

// ── tags + hashtags ───────────────────────────────────────────────────────────

const tags = buildVideoTags();

const streamers = [];
for (const id of ALL_CLIP_IDS) {
  const name = byId[id]?.broadcaster_name;
  if (name && !streamers.includes(name)) streamers.push(name);
}
const hashtagStr = '#DailyDoseOfStream #TwitchClips #TwitchHighlights #Twitch #StreamHighlights #FunnyMoments #StreamerMoments'
  + (streamers.length ? ' ' + streamers.slice(0, 5).map(s => '#' + s.replace(/\s/g, '')).join(' ') : '');

// ── shorts ────────────────────────────────────────────────────────────────────

const shortsMetadata = (plan.shortClipIds || []).map(clipId => {
  const c = byId[clipId] || {};
  const name = c.broadcaster_name || 'Streamer';
  return {
    clipId,
    title: `${name} Had A Moment | Daily Dose Of Stream`,
    caption: `${name} on Twitch 😂 #TwitchClips #Shorts`,
    hashtags: buildShortsTags(clipId),
  };
});

// ── write ─────────────────────────────────────────────────────────────────────

const metadata = {
  titleOptions: ['[Generated by Claude during METADATA stage]'],
  description: 'Your daily dose of the best Twitch moments.\n\n' + chaptersStr + '\n\n' + hashtagStr,
  tags,
  thumbnailText: '',
  shortsMetadata,
};

fs.writeFileSync(path.join(projectDir, 'exports', 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
console.log('[OK] review metadata.json written');
console.log(`Tags (${tags.length}): ${tags.join(', ')}`);
