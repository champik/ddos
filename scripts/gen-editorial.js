#!/usr/bin/env node
// DDOS — Build edit.html from scored-clips.json + template
const fs = require('fs');
const path = require('path');

const runId = process.argv[2];
const RUN_DIR = path.join('projects', runId);
const CLIPS_DIR = path.join(RUN_DIR, 'clips');

const scored = JSON.parse(fs.readFileSync(path.join(CLIPS_DIR, 'scored-clips.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'state.json'), 'utf8'));
const episodeNumber = state.episodeNumber || 13;

// bench-extra.json = clips that were downloaded and scored but swapped out of main 100
const benchExtraPath = path.join(CLIPS_DIR, 'bench-extra.json');
const benchExtraRaw = fs.existsSync(benchExtraPath)
  ? JSON.parse(fs.readFileSync(benchExtraPath, 'utf8'))
  : [];

// Build clip objects for editorial
function buildEditorialClip(c) {
  return {
    id: c.id,
    streamer: c.broadcaster_name,
    category: c._categoryName,
    gameId: c.game_id,
    duration: c.duration,
    ddosScore: c.ddosScore,
    videoPath: '../downloads/' + path.basename(c.localPath),
    title: c.title,
    viewCount: c.view_count,
    language: c.language,
    thumbnailPotential: c.thumbnailPotential,
    shortsPotential: c.shortsPotential,
    emotionalCategory: c.emotionalCategory,
    flags: c.flags || [],
    reasoning: c.reasoning,
  };
}

// Order: JC/IRL → Gaming → Music/Specialty, sorted by ddosScore within each group
// Clips marked bench:true go to bench; rest go to selected
const JC_IRL_IDS = new Set(['509658', '509672']);
const MUSIC_IDS = new Set(['26936', '116747788']);

function clipGroup(c) {
  if (JC_IRL_IDS.has(c.game_id)) return 0;
  if (!MUSIC_IDS.has(c.game_id)) return 1; // Gaming
  return 2; // Music/Specialty
}

const selected = [...scored]
  .sort((a, b) => {
    const gd = clipGroup(a) - clipGroup(b);
    return gd !== 0 ? gd : b.ddosScore - a.ddosScore;
  })
  .map(buildEditorialClip);

// bench = swapped-out clips that were scored but excluded from main selection
// Merge bench-extra scores from processed/<id>/score.json
const benchExtraScored = benchExtraRaw.map((c) => {
  const scorePath = path.join(RUN_DIR, 'processed', c.id, 'score.json');
  const score = fs.existsSync(scorePath) ? JSON.parse(fs.readFileSync(scorePath, 'utf8')) : {};
  return { ...c, ...score };
});

const bench = benchExtraScored
  .sort((a, b) => (b.ddosScore || 0) - (a.ddosScore || 0))
  .map(buildEditorialClip);

const totalDuration = selected.reduce((s, c) => s + c.duration, 0);
console.log(
  `[EDITORIAL] All clips: ${selected.length}, total duration: ${totalDuration.toFixed(0)}s (${(totalDuration / 60).toFixed(1)} min)`,
);

// Build editorial data
const editorialData = {
  runId,
  episodeNumber,
  selected,
  bench,
};

// Read template
const template = fs.readFileSync('assets/editorial/edit-template.html', 'utf8');
const html = template.replace('__CLIPS_JSON__', JSON.stringify(editorialData, null, 2));
fs.writeFileSync(path.join(RUN_DIR, 'edit/edit.html'), html);

// Save episode-plan stub
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
    ddosScore: c.ddosScore,
  })),
};
fs.writeFileSync(
  path.join(RUN_DIR, 'edit/episode-plan.json'),
  JSON.stringify(episodePlan, null, 2),
);

// Update state
state.stages.generate_editorial = 'done';
state.stages.editorial = 'pending';
state.counts.selected = selected.length;
fs.writeFileSync(path.join(RUN_DIR, 'state.json'), JSON.stringify(state, null, 2));

console.log(`[EDITORIAL] edit.html saved to ${path.join(RUN_DIR, 'edit/edit.html')}`);

// Update projects/index.html — add/update Edit button
const indexPath = 'projects/index.html';
let indexHtml = fs.readFileSync(indexPath, 'utf8');
const editBtnHtml = `<a class="btn btn-edit" href="${runId}/edit/edit.html">✏️ Edit</a>`;

if (indexHtml.includes(runId)) {
  // Find the card for this runId and add/replace edit button
  if (!indexHtml.includes(`${runId}/edit/edit.html`)) {
    // Add edit button near the runId reference
    indexHtml = indexHtml.replace(new RegExp(`(${runId}[^"]*"[^>]*>)`), `$1 ${editBtnHtml}`);
  }
} else {
  console.log('[EDITORIAL] Note: runId not found in index.html, manual update needed');
}
fs.writeFileSync(indexPath, indexHtml);

console.log('\n✅ Editorial UI готовий!');
console.log('\nВідкрий у браузері:');
console.log(`  projects/${runId}/edit/edit.html`);
