#!/usr/bin/env node
/**
 * Score clips via Claude API — batches of 8
 */
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node score-clips.js <runId>'); process.exit(1); }

function loadEnv() {
  try {
    fs.readFileSync('.env', 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m) process.env[m[1]] = m[2].trim();
    });
  } catch {}
}
loadEnv();

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

function calcDdosScore(s) {
  return (
    s.retentionScore  * 0.30 +
    s.funnyScore      * 0.25 +
    s.payoffStrength  * 0.20 +
    s.contextClarity  * 0.15 +
    s.noveltyScore    * 0.10 -
    (s.musicRisk > 60   ? (s.musicRisk   - 60) * 0.3 : 0) -
    (s.toxicityRisk > 40 ? (s.toxicityRisk - 40) * 0.5 : 0)
  );
}

function getTranscriptExcerpt(clipId) {
  const p = path.join(processedDir, clipId, 'transcript.json');
  if (!fs.existsSync(p)) return '';
  try {
    const t = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (t.text || '').slice(0, 400);
  } catch { return ''; }
}

async function scoreBatch(client, batch) {
  const clipLines = batch.map((clip, i) => {
    const excerpt = getTranscriptExcerpt(clip.id);
    return `[${i + 1}] ${clip.id}
  Стрімер: ${clip.broadcaster_name}, Категорія: ${clip.game_name}, Мова: ${clip.language}, Тривалість: ${clip.duration}s
  Назва: "${clip.title}"
  Транскрипт: "${excerpt}"`;
  }).join('\n\n');

  const prompt = `Ти оцінюєш Twitch кліпи для "Daily Dose Of Stream".
Канал: смішний, комфортний, курований. Не токсичний.

Оціни кожен кліп від 0 до 100. Будь строгим — більшість кліпів 40-70, лише справді видатні 80+.

Кліпи:
${clipLines}

Відповідай ТІЛЬКИ валідним JSON масивом (без markdown):
[
  {
    "clipId": "...",
    "retentionScore": 0-100,
    "funnyScore": 0-100,
    "payoffStrength": 0-100,
    "contextClarity": 0-100,
    "noveltyScore": 0-100,
    "shortsPotential": 0-100,
    "longFormPotential": 0-100,
    "transitionPotential": 0-100,
    "cooldownPotential": 0-100,
    "musicRisk": 0-100,
    "toxicityRisk": 0-100,
    "singingScore": 0-100,
    "dancingScore": 0-100,
    "rageScore": 0-100,
    "flags": [],
    "reasoning": "1 речення"
  }
]`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text.trim();
  // Strip markdown fences if present
  const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(json);
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

  const client = new Anthropic({ apiKey });
  const clips = JSON.parse(fs.readFileSync(path.join(clipsDir, 'downloaded-clips.json'), 'utf8'));

  updateState({ 'stages.score': 'running' });
  console.log(`Scoring ${clips.length} clips in batches of 8...`);

  const allScores = [];
  const BATCH_SIZE = 8;

  for (let i = 0; i < clips.length; i += BATCH_SIZE) {
    const batch = clips.slice(i, i + BATCH_SIZE);
    process.stdout.write(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(clips.length / BATCH_SIZE)} (clips ${i + 1}-${Math.min(i + BATCH_SIZE, clips.length)})... `);

    let scores;
    try {
      scores = await scoreBatch(client, batch);
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
      // fallback scores
      scores = batch.map(c => ({
        clipId: c.id,
        retentionScore: 50, funnyScore: 50, payoffStrength: 50,
        contextClarity: 50, noveltyScore: 50, shortsPotential: 50,
        longFormPotential: 50, transitionPotential: 50, cooldownPotential: 50,
        musicRisk: 0, toxicityRisk: 0, singingScore: 0, dancingScore: 0,
        rageScore: 0, flags: [], reasoning: 'scoring failed'
      }));
    }

    for (const score of scores) {
      const clip = batch.find(c => c.id === score.clipId);
      if (!clip) continue;
      score.ddosScore = Math.round(calcDdosScore(score));
      const scoreWithMeta = { ...score, broadcaster_name: clip.broadcaster_name, game_name: clip.game_name, duration: clip.duration, title: clip.title, localPath: clip.localPath };
      const scoreDir = path.join(processedDir, score.clipId);
      fs.mkdirSync(scoreDir, { recursive: true });
      fs.writeFileSync(path.join(scoreDir, 'score.json'), JSON.stringify(scoreWithMeta, null, 2));
      allScores.push(scoreWithMeta);
    }

    console.log(`OK (${scores.map(s => calcDdosScore(s).toFixed(0)).join(', ')})`);
  }

  // Sort by ddosScore and save
  allScores.sort((a, b) => b.ddosScore - a.ddosScore);

  // Merge with clip metadata for full scored-clips.json
  const scoredClips = clips.map(clip => {
    const score = allScores.find(s => s.clipId === clip.id) || {};
    return { ...clip, ...score };
  }).sort((a, b) => (b.ddosScore || 0) - (a.ddosScore || 0));

  fs.writeFileSync(path.join(clipsDir, 'scored-clips.json'), JSON.stringify(scoredClips, null, 2));
  updateState({ 'stages.score': 'done', 'counts.scored': scoredClips.length });

  // Print top-20 table
  console.log('\n=== TOP 20 CLIPS ===');
  console.log('# | Стрімер               | Категорія         | DDOS | Funny | Shorts | Rage | Singing | Flags');
  console.log('--|----------------------|-------------------|------|-------|--------|------|---------|------');
  scoredClips.slice(0, 20).forEach((c, i) => {
    const streamer = (c.broadcaster_name || '').padEnd(20).slice(0, 20);
    const cat = (c.game_name || '').padEnd(17).slice(0, 17);
    const flags = (c.flags || []).join(',');
    console.log(`${String(i+1).padStart(2)} | ${streamer} | ${cat} | ${String(c.ddosScore||0).padStart(4)} | ${String(c.funnyScore||0).padStart(5)} | ${String(c.shortsPotential||0).padStart(6)} | ${String(c.rageScore||0).padStart(4)} | ${String(c.singingScore||0).padStart(7)} | ${flags}`);
  });

  console.log(`\nScoring complete: ${scoredClips.length} clips scored`);
}

main().catch(e => {
  console.error('SCORE ERROR:', e.message);
  updateState({ 'stages.score': 'failed' });
  process.exit(1);
});
