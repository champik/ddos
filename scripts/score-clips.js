#!/usr/bin/env node
// Merge scores-raw.json + downloaded-clips.json → scored-clips.json + per-clip score.json
const fs = require('fs');
const path = require('path');

const runId = process.argv[2];
const RUN_DIR = path.join('projects', runId);
const CLIPS_DIR = path.join(RUN_DIR, 'clips');

const scores = JSON.parse(fs.readFileSync(path.join(CLIPS_DIR, 'scores-raw.json'), 'utf8'));
const downloaded = JSON.parse(fs.readFileSync(path.join(CLIPS_DIR, 'downloaded-clips.json'), 'utf8'));
const scoringInput = JSON.parse(fs.readFileSync(path.join(CLIPS_DIR, 'scoring-input.json'), 'utf8'));
// bench-extra: downloaded but excluded from main selection — include in scored-clips.json
const benchExtraPath = path.join(CLIPS_DIR, 'bench-extra.json');
const benchExtra = fs.existsSync(benchExtraPath) ? JSON.parse(fs.readFileSync(benchExtraPath, 'utf8')) : [];
const allClips = [...downloaded, ...benchExtra.filter(b => !downloaded.find(d => d.id === b.id))];

const scoreMap = new Map(scores.map(s => [s.clipId, s]));
const clipMap = new Map(allClips.map(c => [c.id, c]));

// Compute ddosScore
function calcDdosScore(clip, score) {
  const hoursAlive = Math.max((Date.now() - new Date(clip.created_at)) / 3600000, 0.5);
  // viralityRatio proxy: views/hour / 500 (est avg viewers for context)
  const viralityRatio = clip.view_count / hoursAlive / 500;
  const viralityScore = Math.min(100, Math.sqrt(viralityRatio) * 35);

  const raw =
    viralityScore      * 0.30 +
    score.retentionScore * 0.25 +
    score.funnyScore     * 0.20 +
    score.payoffStrength * 0.15 +
    score.contextClarity * 0.10;

  const toxicityPenalty = score.toxicityRisk > 40 ? (score.toxicityRisk - 40) * 0.5 : 0;
  return Math.max(0, Math.min(100, raw - toxicityPenalty));
}

const result = [];
for (const [clipId, score] of scoreMap) {
  const clip = clipMap.get(clipId);
  if (!clip) continue;
  const ddosScore = calcDdosScore(clip, score);
  const si = scoringInput.find(c => c.clipId === clipId);

  result.push({
    id: clipId,
    broadcaster_name: clip.broadcaster_name,
    game_name: clip.game_name,
    game_id: clip.game_id,
    title: clip.title,
    duration: clip.duration,
    view_count: clip.view_count,
    created_at: clip.created_at,
    language: clip.language,
    url: clip.url,
    localPath: clip.localPath,
    ddosScore: Math.round(ddosScore * 10) / 10,
    viralityScore: Math.round(Math.min(100, Math.sqrt(clip.view_count / Math.max((Date.now() - new Date(clip.created_at)) / 3600000, 0.5) / 500) * 35) * 10) / 10,
    ...score
  });

  // Save per-clip score.json
  const processedDir = path.join(RUN_DIR, 'processed', clipId);
  fs.mkdirSync(processedDir, { recursive: true });
  const scoreJson = {
    clipId,
    ddosScore: Math.round(ddosScore * 10) / 10,
    viralityScore: Math.round(Math.min(100, Math.sqrt(clip.view_count / Math.max((Date.now() - new Date(clip.created_at)) / 3600000, 0.5) / 500) * 35) * 10) / 10,
    ...score
  };
  fs.writeFileSync(path.join(processedDir, 'score.json'), JSON.stringify(scoreJson, null, 2));
}

result.sort((a, b) => b.ddosScore - a.ddosScore);
fs.writeFileSync(path.join(CLIPS_DIR, 'scored-clips.json'), JSON.stringify(result, null, 2));

const state = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'state.json'), 'utf8'));
state.counts.scored = result.length;
state.stages.score = 'done';
fs.writeFileSync(path.join(RUN_DIR, 'state.json'), JSON.stringify(state, null, 2));

console.log(`[SCORE] ${result.length} clips scored and saved`);
console.log('\nTop 20 by ddosScore:');
console.log('# | Streamer          | Category         | DDOS | Viral | Funny | Shorts | Flags');
result.slice(0, 20).forEach((c, i) => {
  const flags = c.flags.length ? c.flags.join(',') : '';
  const line = `${(i+1).toString().padStart(2)} | ${c.broadcaster_name.padEnd(17)} | ${c.game_name.slice(0,16).padEnd(16)} | ${c.ddosScore.toFixed(0).padStart(4)} | ${c.viralityScore.toFixed(0).padStart(5)} | ${c.funnyScore.toString().padStart(5)} | ${c.shortsPotential.toString().padStart(6)} | ${flags}`;
  console.log(line);
});
