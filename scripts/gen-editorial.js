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

// Order: JC/IRL → Gaming → Music/Specialty
// JC/IRL: grouped by streamer (streamer rank = best view_count of that streamer)
// Gaming: grouped by game (game rank = best view_count in that game), within game by streamer
function clipGroup(c) {
  if (JCIRL_IDS.has(c.game_id)) return 0;
  if (!SPECIALTY_IDS.has(c.game_id)) return 1; // Gaming
  return 2; // Music/Specialty
}

// Streamer rank = best view_count per streamer within each group
const streamerRank = {};
for (const c of downloaded) {
  const key = `${clipGroup(c)}:${c.broadcaster_name.toLowerCase()}`;
  if (!streamerRank[key] || c.view_count > streamerRank[key]) streamerRank[key] = c.view_count;
}

// Game rank = best view_count per game (Gaming group only)
const gameRank = {};
for (const c of downloaded) {
  if (clipGroup(c) !== 1) continue;
  if (!gameRank[c.game_id] || c.view_count > gameRank[c.game_id]) gameRank[c.game_id] = c.view_count;
}

const selected = [...downloaded]
  .sort((a, b) => {
    const gd = clipGroup(a) - clipGroup(b);
    if (gd !== 0) return gd;
    const g = clipGroup(a);
    if (g === 1) {
      // Gaming: by game → by streamer → by view_count
      const grd = (gameRank[b.game_id] || 0) - (gameRank[a.game_id] || 0);
      if (grd !== 0) return grd;
      const ra = streamerRank[`1:${a.broadcaster_name.toLowerCase()}`] || 0;
      const rb = streamerRank[`1:${b.broadcaster_name.toLowerCase()}`] || 0;
      return ra !== rb ? rb - ra : b.view_count - a.view_count;
    }
    // JC/IRL and rest: by streamer → by view_count
    const ra = streamerRank[`${g}:${a.broadcaster_name.toLowerCase()}`] || 0;
    const rb = streamerRank[`${g}:${b.broadcaster_name.toLowerCase()}`] || 0;
    return ra !== rb ? rb - ra : b.view_count - a.view_count;
  })
  .map(buildEditorialClip);

const totalDuration = selected.reduce((s, c) => s + c.duration, 0);
console.log(
  `[EDITORIAL] All clips: ${selected.length}, total duration: ${totalDuration.toFixed(0)}s (${(totalDuration / 60).toFixed(1)} min)`,
);

// Build editorial data
const existingEditorial = readJsonSafe(path.join(RUN_DIR, 'edit/editorial.json'), null);
const editorialData = {
  runId,
  episodeNumber,
  selected,
  bench: [],
  vodClipIds: existingEditorial?.vodClipIds || [],
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
const html = template.slice(0, sStart) + S_START + dataJson + S_END + template.slice(sEnd + S_END.length);

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

// Write scored-clips.json for downstream compat (no scoring fields, just clip metadata)
const scoredClips = downloaded.map(c => ({
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
