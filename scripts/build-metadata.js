'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node build-metadata.js <projectDir>'); process.exit(1); }

const plan     = JSON.parse(fs.readFileSync(path.join(projectDir, 'edit/episode-plan.json'), 'utf8'));
const scored   = JSON.parse(fs.readFileSync(path.join(projectDir, 'clips/scored-clips.json'), 'utf8'));
const dlPath   = path.join(projectDir, 'clips/downloaded-clips.json');
const dl       = fs.existsSync(dlPath) ? JSON.parse(fs.readFileSync(dlPath, 'utf8').replace(/^﻿/, '')) : [];
const byId     = Object.fromEntries([...dl, ...scored].map(c => [c.id, c]));
const metaPath = path.join(projectDir, 'exports/metadata.json');

// Read Claude-generated metadata if present, otherwise start with empty shell
let meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};

const { fmt, buildVideoTags, buildShortsTags } = require('./lib/metadata-utils');

// ── helpers ───────────────────────────────────────────────────────────────────

function getDur(clipId) {
  const p = path.join(projectDir, 'processed', clipId, 'clean.mp4');
  if (!fs.existsSync(p)) return 0;
  try {
    return parseFloat(execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${p}"`).toString().trim()) || 0;
  } catch { return 0; }
}

// clips actually in the episode, in timeline order
const ALL_CLIP_IDS = plan.groups.flatMap(g => g.clipIds);

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

meta.tags = buildVideoTags(ALL_CLIP_IDS, byId);
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
    ...buildShortsTags(s.clipId, byId),
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
