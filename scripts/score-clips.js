#!/usr/bin/env node
/**
 * score-clips.js — apply Claude-generated scores to clip files
 *
 * Flow:
 *   1. Claude reads clips + transcripts, scores them in conversation
 *   2. Claude writes clips/scores-input.json
 *   3. node score-clips.js <runId>  → creates per-clip score.json + scored-clips.json
 */
const fs = require('fs');
const path = require('path');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node score-clips.js <runId>'); process.exit(1); }

const projectDir = path.join('projects', runId);
const clipsDir = path.join(projectDir, 'clips');
const processedDir = path.join(projectDir, 'processed');

function updateState(updates) {
  const statePath = path.join(projectDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const [key, val] of Object.entries(updates)) {
    const parts = key.split('.');
    let obj = state;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = val;
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function calcDdosScore(s, viralityRatio = 0) {
  const viralityScore = Math.min(100, Math.sqrt(viralityRatio) * 35);
  return Math.round(
    viralityScore       * 0.30 +
    s.retentionScore    * 0.25 +
    s.funnyScore        * 0.20 +
    s.payoffStrength    * 0.15 +
    s.contextClarity    * 0.10 -
    (s.toxicityRisk > 40 ? (s.toxicityRisk - 40) * 0.5 : 0)
  );
}

function main() {
  const scoresInputPath = path.join(clipsDir, 'scores-input.json');
  if (!fs.existsSync(scoresInputPath)) {
    console.error(`scores-input.json not found at ${scoresInputPath}`);
    console.error('Claude must score clips in conversation first and write that file.');
    process.exit(1);
  }

  const scores = JSON.parse(fs.readFileSync(scoresInputPath, 'utf8'));
  const clips = JSON.parse(fs.readFileSync(path.join(clipsDir, 'downloaded-clips.json'), 'utf8'));
  const clipsById = Object.fromEntries(clips.map(c => [c.id, c]));

  console.log(`Applying ${scores.length} scores...`);
  const allScores = [];

  for (const score of scores) {
    const clip = clipsById[score.clipId];
    if (!clip) { console.warn(`  WARN: clip not found for ${score.clipId}`); continue; }

    score.ddosScore = calcDdosScore(score, clip.viralityRatio || 0);
    const full = { ...score, broadcaster_name: clip.broadcaster_name, game_name: clip.game_name, duration: clip.duration, title: clip.title, localPath: clip.localPath };

    const scoreDir = path.join(processedDir, score.clipId);
    fs.mkdirSync(scoreDir, { recursive: true });
    fs.writeFileSync(path.join(scoreDir, 'score.json'), JSON.stringify(full, null, 2));
    allScores.push(full);
  }

  allScores.sort((a, b) => b.ddosScore - a.ddosScore);

  const scoredClips = clips.map(clip => {
    const score = allScores.find(s => s.clipId === clip.id) || {};
    return { ...clip, ...score };
  }).sort((a, b) => (b.ddosScore || 0) - (a.ddosScore || 0));

  fs.writeFileSync(path.join(clipsDir, 'scored-clips.json'), JSON.stringify(scoredClips, null, 2));
  updateState({ 'stages.score': 'done', 'counts.scored': scoredClips.length });

  console.log('\n=== TOP 20 CLIPS ===');
  console.log('# | Стрімер               | Категорія         | DDOS | Viral | Funny | Shorts | Rage | Singing');
  console.log('--|----------------------|-------------------|------|-------|-------|--------|------|--------');
  scoredClips.slice(0, 20).forEach((c, i) => {
    const streamer = (c.broadcaster_name || '').padEnd(20).slice(0, 20);
    const cat = (c.game_name || '').padEnd(17).slice(0, 17);
    const viral = (c.viralityRatio || 0).toFixed(2);
    console.log(`${String(i+1).padStart(2)} | ${streamer} | ${cat} | ${String(c.ddosScore||0).padStart(4)} | ${viral.padStart(5)} | ${String(c.funnyScore||0).padStart(5)} | ${String(c.shortsPotential||0).padStart(6)} | ${String(c.rageScore||0).padStart(4)} | ${String(c.singingScore||0).padStart(7)}`);
  });

  console.log(`\nDone: ${scoredClips.length} clips scored`);
}

main();
