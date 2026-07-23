'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readJson, readJsonSafe, writeJsonAtomic } = require('./lib/state');
const { reconnectAfterSet, clipSequence, buildChapters } = require('./lib/timeline');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node build-metadata.js <projectDir>'); process.exit(1); }

const plan      = readJson(path.join(projectDir, 'edit/episode-plan.json'));
const editorial = readJsonSafe(path.join(projectDir, 'edit/editorial.json'), {});
const scored    = readJson(path.join(projectDir, 'clips/scored-clips.json'));
const dl        = readJsonSafe(path.join(projectDir, 'clips/downloaded-clips.json'), []);
const byId      = Object.fromEntries([...dl, ...scored].map(c => [c.id, c]));
const metaPath  = path.join(projectDir, 'exports/metadata.json');

// Read Claude-generated metadata if present, otherwise start with empty shell
let meta = readJsonSafe(metaPath, {});

const { fmt, buildVideoTags, buildDescriptionHashtags } = require('./lib/metadata-utils');
const { streamerDisplayName } = require('./lib/display-name');

// ── helpers ───────────────────────────────────────────────────────────────────

function getDur(clipId) {
  // score.json кешує тривалість — clean.mp4 може бути видалений cleanup-ом
  const sc = readJsonSafe(path.join(projectDir, 'processed', clipId, 'score.json'));
  if (sc?.trimmedDuration) return sc.trimmedDuration;
  const p = path.join(projectDir, 'processed', clipId, 'clean.mp4');
  if (!fs.existsSync(p)) return 0;
  try {
    return parseFloat(execFileSync('ffprobe',
      ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', p],
      { encoding: 'utf8' }).trim()) || 0;
  } catch { return 0; }
}

// Clips actually in the episode, in timeline order.
// Джерело правди — editorial.clipOrder (як у build-concat); fallback на plan.groups.
const ALL_CLIP_IDS = editorial.clipOrder ? clipSequence(editorial) : plan.groups.flatMap(g => g.clipIds);


// ── chapters (broadcaster_name per clip, new chapter on streamer change) ───────
// Reconnect-позиції — з editorial.json (lib/timeline), тобто рівно там,
// де build-concat реально вставив reconnecting.mp4 у відео.

const INTRO_DUR     = 1.25;
const reconnectPath = path.join(projectDir, 'edit', 'reconnecting.mp4');
const RECONNECT_DUR = (() => {
  if (!fs.existsSync(reconnectPath)) return 1.0;
  try {
    return parseFloat(execFileSync('ffprobe',
      ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', reconnectPath],
      { encoding: 'utf8' }).trim()) || 1.0;
  } catch { return 1.0; }
})();

const chapters = buildChapters({
  clipIds: ALL_CLIP_IDS,
  reconnectAfter: reconnectAfterSet(editorial),
  getDur,
  getStreamer: id => { const c = byId[id]; return c ? streamerDisplayName(c) : '?'; },
  introDur: INTRO_DUR,
  reconnectDur: RECONNECT_DUR,
});

const chaptersStr = chapters.map(c => fmt(c.t) + ' ' + c.label).join('\n');

// ── assemble ──────────────────────────────────────────────────────────────────

const autoTags = buildVideoTags(ALL_CLIP_IDS, byId);
const eventTags = meta.eventTags || [];
// event tags inserted after base (first 15) so they take priority over streamer tags
const BASE_COUNT = 15;
meta.tags = [...new Set([...autoTags.slice(0, BASE_COUNT), ...eventTags, ...autoTags.slice(BASE_COUNT)])].slice(0, 30);

// Replace timecodes + hashtags (strip old ones first, then append fresh)
if (meta.description) {
  const cutAt = meta.description.indexOf('\n\n00:00');
  const base = cutAt !== -1 ? meta.description.slice(0, cutAt) : meta.description;
  meta.description = base + '\n\n' + chaptersStr + '\n\n' + buildDescriptionHashtags(ALL_CLIP_IDS, byId);
}

fs.mkdirSync(path.join(projectDir, 'exports'), { recursive: true });
writeJsonAtomic(metaPath, meta);

console.log('[OK] metadata.json written');
console.log(`\nTags (${meta.tags.length}): ${meta.tags.join(', ')}`);
console.log('\nChapters:\n' + chaptersStr);
if (Array.isArray(meta.titleOptions) && meta.titleOptions.length > 0) {
  console.log('\nThumbnail captions (pipe-style):');
  meta.titleOptions.forEach((t, i) => console.log(`  [${i+1}] ${t}`));
}
