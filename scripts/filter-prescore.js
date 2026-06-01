#!/usr/bin/env node
// DDOS Pipeline — FILTER + PRE-SCORE (from existing raw-clips.json)
// Usage: node scripts/filter-prescore.js <runId>

'use strict';

const fs = require('fs');
const path = require('path');

const [,, runId] = process.argv;
const RUN_DIR = path.join('projects', runId);
const CLIPS_DIR = path.join(RUN_DIR, 'clips');

function readState() {
  const raw = fs.readFileSync(path.join(RUN_DIR, 'state.json'), 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}
function writeState(state) {
  fs.writeFileSync(path.join(RUN_DIR, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

const allClips = JSON.parse(fs.readFileSync(path.join(CLIPS_DIR, 'raw-clips.json'), 'utf8').replace(/^﻿/, ''));
console.log(`[FILTER] ${allClips.length} raw clips`);

// ---- FILTER ----
const ORG_BLACKLIST = new Set([
  'esl_csgo','eslcs','blasttv','pgl','riotgames','valorant','esl_dota2',
  'weplay_esports','faceit','dreamhack','esltv','iem'
]);
const STREAMER_BLACKLIST = new Set(['lyasyaa']);
const RU_KEYWORDS = ['русский','россия','russian','путін','рф'];
const TOURNAMENT_KEYWORDS = [' major',' grand final','championship',' tournament','qualifier'];
const GAMBLING_NAMES = ['slots','casino','gambling','betting','poker','escape from tarkov','marvel rivals','overwatch'];

const filtered = [];
const rejected = [];

for (const clip of allClips) {
  const lang = (clip.language || '').toLowerCase();
  const title = (clip.title || '').toLowerCase();
  const broadcaster = (clip.broadcaster_name || '').toLowerCase();
  const gameName = (clip.game_name || '').toLowerCase();

  let rejectReason = null;

  if (lang !== 'en') rejectReason = 'non_english';
  else if (RU_KEYWORDS.some(k => title.includes(k))) rejectReason = 'ru_keyword';
  else if (STREAMER_BLACKLIST.has(broadcaster)) rejectReason = 'streamer_blacklist';
  else if (ORG_BLACKLIST.has(broadcaster)) rejectReason = 'tournament_official';
  else if (TOURNAMENT_KEYWORDS.some(k => title.includes(k))) rejectReason = 'tournament_event';
  else if (GAMBLING_NAMES.some(k => gameName.includes(k))) rejectReason = 'gambling';
  else if (clip.duration < 6 || clip.duration > 90) rejectReason = 'duration';

  if (rejectReason) rejected.push({ ...clip, rejectReason });
  else filtered.push(clip);
}

console.log(`[FILTER] filtered: ${filtered.length}, rejected: ${rejected.length}`);
const byReason = {};
for (const r of rejected) byReason[r.rejectReason] = (byReason[r.rejectReason] || 0) + 1;
console.log('[FILTER] Rejection reasons:', JSON.stringify(byReason));

fs.writeFileSync(path.join(CLIPS_DIR, 'filtered-clips.json'), JSON.stringify(filtered, null, 2), 'utf8');
fs.writeFileSync(path.join(CLIPS_DIR, 'rejected-clips.json'), JSON.stringify(rejected, null, 2), 'utf8');

let state = readState();
state.counts.filtered = filtered.length;
state.stages.filter = 'done';
state.stages.prescore = 'running';
writeState(state);

// ---- PRE-SCORE ----
console.log('[PRE-SCORE] Calculating scores...');

const CORE_IDS_ARR = ['509658','509672','26936','509667','509671','116747788','417752'];

const broadcasterMaxViews = new Map();
for (const clip of filtered) {
  const cur = broadcasterMaxViews.get(clip.broadcaster_name) || 0;
  if (clip.view_count > cur) broadcasterMaxViews.set(clip.broadcaster_name, clip.view_count);
}

function calcPreScore(clip, seenStreamers, seenCategories) {
  const hoursAlive = Math.max((Date.now() - new Date(clip.created_at)) / 3600000, 0.5);
  const velocity = clip.view_count / hoursAlive;
  const velocityScore = Math.min(100, (Math.log10(velocity + 1) / Math.log10(5000)) * 100);

  const maxViews = broadcasterMaxViews.get(clip.broadcaster_name) || clip.view_count;
  const ratioScore = Math.min(100, (clip.view_count / Math.max(maxViews, 1)) * 100);

  const categoryScore = CORE_IDS_ARR.includes(clip.game_id) ? 88 : 60;

  const d = clip.duration;
  const durationScore = d >= 15 && d <= 60 ? 100 : d < 15 ? 60 : 70;

  const title = (clip.title || '').toLowerCase();
  const riskPenalty = title.includes('music') || title.includes('song') ? 15 : 0;

  const baseScore = (
    velocityScore * 0.40 +
    ratioScore    * 0.15 +
    categoryScore * 0.25 +
    durationScore * 0.20
  ) - riskPenalty;

  const streamerCount = seenStreamers.get(clip.broadcaster_name) || 0;
  const categoryCount = seenCategories.get(clip.game_id) || 0;
  const streamerMult  = streamerCount === 0 ? 1.0 : streamerCount === 1 ? 0.85 : 0.70;
  const categoryMult  = categoryCount < 5  ? 1.0 : categoryCount < 10  ? 0.90 : 0.80;

  const isViral = velocityScore > 80 || (ratioScore >= 100 && velocityScore > 60);
  const diversityMult = isViral ? 1.0 : streamerMult * categoryMult;

  return Math.max(0, Math.min(100, baseScore * diversityMult));
}

const seenStreamers  = new Map();
const seenCategories = new Map();
const scored = filtered
  .sort((a, b) => {
    const va = a.view_count / Math.max((Date.now() - new Date(a.created_at)) / 3600000, 0.5);
    const vb = b.view_count / Math.max((Date.now() - new Date(b.created_at)) / 3600000, 0.5);
    return vb - va;
  })
  .map(clip => {
    const score = calcPreScore(clip, seenStreamers, seenCategories);
    seenStreamers.set(clip.broadcaster_name, (seenStreamers.get(clip.broadcaster_name) || 0) + 1);
    seenCategories.set(clip.game_id, (seenCategories.get(clip.game_id) || 0) + 1);
    return { ...clip, preScore: score };
  })
  .sort((a, b) => b.preScore - a.preScore);

const N = 100;
const top35   = scored.slice(0, Math.floor(N * 0.35));
const midPool = scored.slice(Math.floor(scored.length * 0.30), Math.floor(scored.length * 0.70));
const mid35   = midPool.sort(() => Math.random() - 0.5).slice(0, Math.floor(N * 0.35));
const gemsPool = scored.slice(Math.floor(scored.length * 0.70), Math.floor(scored.length * 0.90));
const gems15  = gemsPool.sort(() => Math.random() - 0.5).slice(0, Math.floor(N * 0.15));
const small10 = scored.filter(c => c.view_count < 10000).sort(() => Math.random() - 0.5).slice(0, Math.floor(N * 0.10));
const trending5 = scored.filter(c => !CORE_IDS_ARR.includes(c.game_id)).slice(0, Math.floor(N * 0.05));

const seen2 = new Set();
const toDownload = [];
for (const c of [...top35, ...mid35, ...gems15, ...small10, ...trending5]) {
  if (!seen2.has(c.id)) { seen2.add(c.id); toDownload.push(c); }
  if (toDownload.length >= 100) break;
}

console.log(`[PRE-SCORE] Selected ${toDownload.length} clips for download`);
console.log(`  top35=${top35.length}, mid35=${mid35.length}, gems15=${gems15.length}, small10=${small10.length}, trending5=${trending5.length}`);

fs.writeFileSync(path.join(CLIPS_DIR, 'prescore-candidates.json'), JSON.stringify(toDownload, null, 2), 'utf8');

state = readState();
state.stages.prescore = 'done';
state.stages.download = 'running';
writeState(state);

console.log('\nTop 15 clips by preScore:');
toDownload.slice(0, 15).forEach((c, i) => {
  console.log(`  ${i+1}. [${c.preScore.toFixed(1)}] ${c.broadcaster_name} — "${c.title.slice(0,60)}" (${c.game_name}, ${c.view_count} views, ${c.duration}s)`);
});
