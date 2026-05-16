#!/usr/bin/env node
'use strict';
// gen-hooks.js — prints clip data for in-conversation hook generation by Claude
// Claude generates all hooks in one batch in the conversation, then saves hook.txt files directly.
// Usage: node scripts/gen-hooks.js <runId>
const fs   = require('fs');
const path = require('path');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node gen-hooks.js <runId>'); process.exit(1); }

const projectDir  = path.join('projects', runId);
const processedDir = path.join(projectDir, 'processed');
const plan        = JSON.parse(fs.readFileSync(path.join(projectDir, 'edit/episode-plan.json'), 'utf8'));
const scoredClips = JSON.parse(fs.readFileSync(path.join(projectDir, 'clips/scored-clips.json'), 'utf8'));

function getTranscript(clipId) {
  const p = path.join(processedDir, clipId, 'transcript.json');
  if (!fs.existsSync(p)) return '';
  try { return (JSON.parse(fs.readFileSync(p, 'utf8')).text || '').slice(0, 300); } catch { return ''; }
}

const allIds = [...(plan.clipOrder || []), plan.chillPlan?.singingClipId].filter(Boolean);

console.log('\n=== HOOKS — clip data for in-conversation generation ===\n');
console.log('Згенеруй хуки для цих кліпів. Стиль: ALL CAPS, 2-5 слів, anticipation/sarcasm, без спойлерів.\n');

for (const clipId of allIds) {
  const hookPath = path.join(processedDir, clipId, 'hook.txt');
  if (fs.existsSync(hookPath)) {
    const cached = fs.readFileSync(hookPath, 'utf8').trim();
    console.log(`[CACHED] ${clipId.slice(0, 28)} → ${cached}`);
    continue;
  }
  const clip = scoredClips.find(c => c.id === clipId || c.clipId === clipId);
  const transcript = getTranscript(clipId);
  console.log(`[CLIP] ${clipId}`);
  console.log(`  Стрімер: ${clip?.broadcaster_name || '?'}, Категорія: ${clip?.game_name || '?'}`);
  console.log(`  Назва: "${clip?.title || '?'}"`);
  if (transcript) console.log(`  Транскрипт: "${transcript}"`);
  console.log('');
}

console.log('\nПісля генерації збережи кожен хук: fs.writeFileSync("processed/<clipId>/hook.txt", "HOOK TEXT")');
