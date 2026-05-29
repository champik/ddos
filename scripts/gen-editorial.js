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

// Build clip objects for editorial
function buildEditorialClip(c) {
  return {
    id: c.id,
    streamer: c.broadcaster_name,
    category: c.game_name,
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
    reasoning: c.reasoning
  };
}

// Select clips for episode
// Rules: 12-15 min, max 3 per streamer, 50%+ JC/IRL, quality first
const JC_IRL_IDS = new Set(['509658', '509672']);
const streamerCount = new Map();

const SKIP_FLAGS = new Set(['high_toxicity']);

const selected = [];
let totalDuration = 0;
const TARGET_MIN = 720;
const TARGET_MAX = 900;

// Exclude flagged clips from auto-selection
const eligible = scored.filter(c => !c.flags.some(f => SKIP_FLAGS.has(f)));

const jcIrlEligible = eligible.filter(c => JC_IRL_IDS.has(c.game_id));
const otherEligible = eligible.filter(c => !JC_IRL_IDS.has(c.game_id));

// Target: 50% JC/IRL → fill up to half the episode with JC/IRL, rest with other
const JCIRL_TARGET = TARGET_MIN * 0.55; // ~55% of min gives breathing room

// Phase 1: add top JC/IRL clips until we hit JCIRL_TARGET duration
for (const c of jcIrlEligible) {
  if (totalDuration >= JCIRL_TARGET) break;
  const count = streamerCount.get(c.broadcaster_name) || 0;
  if (count >= 3) continue;
  selected.push(buildEditorialClip(c));
  totalDuration += c.duration;
  streamerCount.set(c.broadcaster_name, count + 1);
}

// Phase 2: fill with non-JC/IRL to hit TARGET_MIN while keeping JC/IRL >= 50%
for (const c of otherEligible) {
  if (totalDuration >= TARGET_MAX) break;
  const count = streamerCount.get(c.broadcaster_name) || 0;
  if (count >= 3) continue;
  const jcIrlDur = selected.filter(s => JC_IRL_IDS.has(s.gameId)).reduce((a, s) => a + s.duration, 0);
  // Stop if adding this would push JC/IRL below 50% of total AND we already hit minimum
  if ((jcIrlDur / (totalDuration + c.duration)) < 0.50 && totalDuration >= TARGET_MIN) break;
  selected.push(buildEditorialClip(c));
  totalDuration += c.duration;
  streamerCount.set(c.broadcaster_name, count + 1);
}

// Bench: all other eligible clips not selected
const selectedIds = new Set(selected.map(s => s.id));
const bench = eligible
  .filter(c => !selectedIds.has(c.id))
  .map(buildEditorialClip);

console.log(`[EDITORIAL] Selected: ${selected.length} clips, total duration: ${totalDuration.toFixed(0)}s (${(totalDuration/60).toFixed(1)} min)`);
const jcIrlPct = Math.round(selected.filter(s => JC_IRL_IDS.has(s.gameId)).length / selected.length * 100);
console.log(`[EDITORIAL] JC/IRL: ${jcIrlPct}%`);

// Build editorial data
const editorialData = {
  runId,
  episodeNumber,
  selected,
  bench
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
  clips: selected.map(c => ({ id: c.id, streamer: c.streamer, title: c.title, duration: c.duration, ddosScore: c.ddosScore }))
};
fs.writeFileSync(path.join(RUN_DIR, 'edit/episode-plan.json'), JSON.stringify(episodePlan, null, 2));

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
    indexHtml = indexHtml.replace(
      new RegExp(`(${runId}[^"]*"[^>]*>)`),
      `$1 ${editBtnHtml}`
    );
  }
} else {
  console.log('[EDITORIAL] Note: runId not found in index.html, manual update needed');
}
fs.writeFileSync(indexPath, indexHtml);

console.log('\n✅ Editorial UI готовий!');
console.log('\nВідкрий у браузері:');
console.log(`  projects/${runId}/edit/edit.html`);
