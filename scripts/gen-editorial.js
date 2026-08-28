#!/usr/bin/env node
// DDOS — Build edit.html from scored-clips.json + template
const fs = require('fs');
const path = require('path');
const { readJson, readJsonSafe, updateState } = require('./lib/state');
const { getProjectDir, monthFolderFromRunId } = require('./lib/project-path');
const { JCIRL_IDS, SPECIALTY_IDS } = require('./lib/categories');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node scripts/gen-editorial.js <runId>'); process.exit(1); }
const RUN_DIR = getProjectDir(runId);
const CLIPS_DIR = path.join(RUN_DIR, 'clips');

const allDownloaded = readJson(path.join(CLIPS_DIR, 'downloaded-clips.json'));
const gamingScreen = readJsonSafe(path.join(CLIPS_DIR, 'gaming-screen-results.json'), {});
// Виключаємо gaming кліпи що не пройшли gaming-screen
const downloaded = allDownloaded.filter(c => {
  const isGaming = !JCIRL_IDS.has(c.game_id) && !SPECIALTY_IDS.has(c.game_id);
  if (!isGaming) return true;
  const result = gamingScreen[c.id];
  return result ? result.pass === true : true;
});
const state = readJson(path.join(RUN_DIR, 'state.json'));
const episodeNumber = state.episodeNumber || 1;

// Cap: at most 5 clips per streamer per episode (keep the highest view_count).
// The download-selection maxClipsPerStreamer is 5, but the JC/IRL diversity-floor
// and the custom-hours recency-compensation pools have NO per-streamer limit, so
// the pool handed to editorial can carry >5 for a prolific streamer (e.g. an IRL
// trip that spawns many clips). Trim here so one streamer can't dominate the
// episode / the edit UI. Per-run override: state.maxClipsPerStreamer.
const MAX_CLIPS_PER_STREAMER = state.maxClipsPerStreamer || 5;
function capPerStreamer(clips, limit) {
  const byStreamer = new Map();
  for (const c of clips) {
    const k = c.broadcaster_name.toLowerCase();
    if (!byStreamer.has(k)) byStreamer.set(k, []);
    byStreamer.get(k).push(c);
  }
  const keep = new Set();
  for (const list of byStreamer.values()) {
    [...list].sort((a, b) => b.view_count - a.view_count)
      .slice(0, limit)
      .forEach(c => keep.add(c.id));
  }
  return clips.filter(c => keep.has(c.id));
}
const capped = capPerStreamer(downloaded, MAX_CLIPS_PER_STREAMER);
const cappedOut = downloaded.length - capped.length;
if (cappedOut > 0) {
  console.log(`[EDITORIAL] Per-streamer cap (${MAX_CLIPS_PER_STREAMER}/streamer): dropped ${cappedOut} clip(s)`);
}

function buildEditorialClip(c) {
  return {
    id: c.id,
    streamer: c.broadcaster_name,
    category: c.game_name || c._categoryName,
    gameId: c.game_id,
    duration: c.duration,
    createdAt: c.created_at,
    broadcastedAt: c.broadcastedAt || c.created_at,
    broadcastedAtSource: c.broadcastedAtSource || 'clip',
    videoPath: '../downloads/' + path.basename(c.localPath),
    title: c.title,
    viewCount: c.view_count,
    language: c.language,
    url: c.url,
  };
}

// Optional per-run override: state.priorityStreamers = ["kaicenat", "ishowspeed"]
// pins those streamers' clips to the front, ahead of the normal group sort below
// — regardless of category, and interleaved with each other (not one streamer's
// block then the other's) by broadcastedAt (VOD start + offset — when the moment
// actually happened, not when the clip resource was created). Empty/absent = no-op.
const PRIORITY_STREAMERS = (state.priorityStreamers || []).map(s => s.toLowerCase());
function isPriority(c) {
  return PRIORITY_STREAMERS.includes(c.broadcaster_name.toLowerCase());
}

// Optional per-run override: state.categoryOrder = ["Just Chatting", "IRL", ...]
// forces category (game_name) order exactly as given, ignoring the normal
// JC/IRL→Gaming→Specialty bucket + rank sort below. Categories not listed fall
// back to the end, in their normal bucket/rank order. Empty/absent = no-op.
const CATEGORY_ORDER = state.categoryOrder || [];
function categoryOrderRank(c) {
  const i = CATEGORY_ORDER.indexOf(c.game_name);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

// Optional per-run override: state.viewOrderAscending = true — within a
// category, orders clips from fewest → most views (build-up/countdown
// structure) instead of the normal best-first. Used by ranking-style
// episodes (e.g. TopClips) where the video plays low→high per category and
// the on-screen rank number / processed/ filename NN must match that order.
const VIEW_ASC = state.viewOrderAscending === true ? -1 : 1;

// Order: JC/IRL bucket → Gaming bucket → Music/Specialty bucket.
// Within a bucket: by category (game_name) — category rank = best view_count in
// that category. Within a category: grouped by streamer — a streamer's block is
// positioned by their single best clip's view_count, and that streamer's clips
// stay back-to-back, ordered by view_count. So Just Chatting and IRL are their
// own sections (not merged), each streamer-grouped; same for every gaming
// category. Keeping one streamer's clips consecutive is the per-episode default
// — makes the editorial pass and the CapCut drag-in far easier. Overridden by
// state.categoryOrder / state.priorityStreamers when set.
function clipGroup(c) {
  if (JCIRL_IDS.has(c.game_id)) return 0;
  if (!SPECIALTY_IDS.has(c.game_id)) return 1; // Gaming
  return 2; // Music/Specialty
}

// Category rank = best view_count per game_id (across the whole pool)
const gameRank = {};
for (const c of capped) {
  if (!gameRank[c.game_id] || c.view_count > gameRank[c.game_id]) gameRank[c.game_id] = c.view_count;
}

// Streamer rank = best view_count per streamer WITHIN a category (game_id) —
// so the same streamer appearing in two categories is ranked separately in each.
const streamerRank = {};
for (const c of capped) {
  const key = `${c.game_id}:${c.broadcaster_name.toLowerCase()}`;
  if (!streamerRank[key] || c.view_count > streamerRank[key]) streamerRank[key] = c.view_count;
}

const selected = [...capped]
  .sort((a, b) => {
    const pa = isPriority(a), pb = isPriority(b);
    if (pa !== pb) return pa ? -1 : 1;
    if (pa) { // both priority — chronological by when the moment happened
      const ta = new Date(a.broadcastedAt || a.created_at).getTime();
      const tb = new Date(b.broadcastedAt || b.created_at).getTime();
      return ta - tb;
    }
    if (CATEGORY_ORDER.length > 0) {
      const cod = categoryOrderRank(a) - categoryOrderRank(b);
      if (cod !== 0) return cod;
      return (b.view_count - a.view_count) * VIEW_ASC;
    }
    // bucket → category → streamer-block → view_count within the streamer
    const gd = clipGroup(a) - clipGroup(b);
    if (gd !== 0) return gd;
    const crd = (gameRank[b.game_id] || 0) - (gameRank[a.game_id] || 0);
    if (crd !== 0) return crd;
    const ra = streamerRank[`${a.game_id}:${a.broadcaster_name.toLowerCase()}`] || 0;
    const rb = streamerRank[`${b.game_id}:${b.broadcaster_name.toLowerCase()}`] || 0;
    if (ra !== rb) return rb - ra;
    return (b.view_count - a.view_count) * VIEW_ASC;
  })
  .map(buildEditorialClip);

const totalDuration = selected.reduce((s, c) => s + c.duration, 0);
console.log(
  `[EDITORIAL] All clips: ${selected.length}, total duration: ${totalDuration.toFixed(0)}s (${(totalDuration / 60).toFixed(1)} min)`,
);

// Build editorial data
const existingEditorial = readJsonSafe(path.join(RUN_DIR, 'edit/editorial.json'), null);
// Embedded as a data URI (not a relative path) so the browser-preview mute in
// edit.html works regardless of how deep this episode's folder is nested
// (projects/<Month>/<runId>/edit/ vs projects/Special/<Series>/<Day>/edit/...).
const GLITCH_PATH = 'assets/sounds/glitch.wav';
const glitchAudio = fs.existsSync(GLITCH_PATH)
  ? 'data:audio/wav;base64,' + fs.readFileSync(GLITCH_PATH).toString('base64')
  : null;
const editorialData = {
  runId,
  episodeNumber,
  selected,
  bench: [],
  vodClipIds: existingEditorial?.vodClipIds || [],
  glitchAudio,
};

// Read template from projects/Edit — source of truth for edit UI
const TEMPLATE_PATH = 'projects/Edit/edit/edit.html';
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

const S_START = '/*DDOS_CLIPS_START*/';
const S_END   = '/*DDOS_CLIPS_END*/';
const sStart  = template.indexOf(S_START);
const sEnd    = template.indexOf(S_END);
if (sStart === -1 || sEnd === -1) throw new Error('DDOS_CLIPS sentinels not found in projects/Edit/edit/edit.html');

const dataJson = JSON.stringify(editorialData, null, 2);
let html = template.slice(0, sStart) + S_START + dataJson + S_END + template.slice(sEnd + S_END.length);

// edit.html lives at <RUN_DIR>/edit/edit.html. RUN_DIR's own depth from repo root
// varies (standard: projects/<Month>/<runId> = 3 segments; multi-day Special:
// projects/Special/<Series>/<Day> = 4 segments) — compute the ../ chain instead
// of trusting the template's hardcoded one, so nested Special series don't end
// up with a broken logo/index link (same bug already fixed in gen-review.js).
const runDepth = RUN_DIR.split(/[\\/]/).filter(Boolean).length;
const toProjectsDir = '../'.repeat(runDepth);
html = html.replace('href="../../index.html"', `href="${toProjectsDir}index.html"`);

fs.writeFileSync(path.join(RUN_DIR, 'edit/edit.html'), html);

// Save episode-plan stub — only if clipOrder not yet set (resume hasn't run yet)
const episodePlanPath = path.join(RUN_DIR, 'edit/episode-plan.json');
const existingPlan = readJsonSafe(episodePlanPath, null);
if (!existingPlan?.clipOrder) {
  const episodePlan = {
    runId,
    episodeNumber,
    generatedAt: new Date().toISOString(),
    selectedCount: selected.length,
    totalDurationEstimate: totalDuration,
    clips: selected.map((c) => ({
      id: c.id,
      streamer: c.streamer,
      title: c.title,
      duration: c.duration,
    })),
  };
  fs.writeFileSync(episodePlanPath, JSON.stringify(episodePlan, null, 2));
}

updateState(RUN_DIR, s => {
  s.stages.generate_editorial = 'done';
  s.stages.editorial = 'pending';
  s.counts.selected = selected.length;
});

// Write scored-clips.json for downstream compat (no scoring fields, just clip
// metadata). Uses the per-streamer-capped set — matches what's in the edit UI,
// so a capped-out clip can't be referenced by editorial.thumbnails etc.
const scoredClips = capped.map(c => ({
  ...c,
  _categoryName: c._categoryName || c.game_name || c._category,
}));
fs.writeFileSync(path.join(CLIPS_DIR, 'scored-clips.json'), JSON.stringify(scoredClips, null, 2));

console.log(`[EDITORIAL] edit.html saved to ${path.join(RUN_DIR, 'edit/edit.html')}`);

// Update projects/index.html — add/update Edit button
const indexPath = 'projects/index.html';
let indexHtml = fs.readFileSync(indexPath, 'utf8');
const monthFolder = monthFolderFromRunId(runId);
const hrefPrefix = monthFolder ? `${monthFolder}/${runId}` : runId;
const editBtnHtml = `<a class="btn btn-edit" href="${hrefPrefix}/edit/edit.html">✏️ Edit</a>`;

// Only update index.html for dated episode runs (Episode_N_YYYY_MM_DD, Special_*, etc.)
if (/^\w+_\d+_\d{4}_\d{2}_\d{2}$/.test(runId)) {
  if (indexHtml.includes(runId)) {
    if (!indexHtml.includes(`${hrefPrefix}/edit/edit.html`)) {
      // Insert edit button into the links-row of this episode's card
      indexHtml = indexHtml.replace(
        new RegExp(`(href="${hrefPrefix.replace(/\//g, '\\/')}/review/review\\.html">Review</a>)`),
        `$1\n      ${editBtnHtml}`
      );
    }
  } else {
    console.log('[EDITORIAL] Note: runId not found in index.html, manual update needed');
  }
}
fs.writeFileSync(indexPath, indexHtml);

console.log('\n✅ Editorial UI готовий!');
console.log('\nВідкрий у браузері:');
console.log(`  ${RUN_DIR}/edit/edit.html`);
