'use strict';
const fs = require('fs');
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }

const scored    = readJson('projects/Test_1_2026_05_15/clips/scored-clips.json');
const downloaded = readJson('projects/Test_1_2026_05_15/clips/downloaded-clips.json');
const plan      = readJson('projects/Episode_1_2026_05_16/edit/episode-plan.json');
const usedIds   = new Set(plan.clipOrder);

const dlMap = {};
for (const c of downloaded) dlMap[c.id] = c;

const JC_IRL = new Set(['509658', '509672']);
const ASIAN  = new Set(['ja', 'ko', 'zh', 'th']);

const candidates = scored
  .filter(c => {
    if (usedIds.has(c.id)) return false;
    const dl = dlMap[c.id];
    if (!dl || !dl.localPath) return false;
    if (!fs.existsSync(dl.localPath)) return false;
    if (!JC_IRL.has(String(c.game_id))) return false;
    if (ASIAN.has((c.language || '').toLowerCase())) return false;
    if ((c.musicRisk || 0) > 65) return false;
    if ((c.toxicityRisk || 0) > 50) return false;
    return true;
  })
  .sort((a, b) => b.ddosScore - a.ddosScore)
  .slice(0, 15);

candidates.forEach((c, i) => {
  const dl = dlMap[c.id];
  console.log((i+1)+'|'+c.broadcaster_name+'|'+Math.round(c.ddosScore)+'|'+Math.round(c.funnyScore)+'|'+dl.duration+'s|'+(c.language||'?')+'|'+c.title+'|'+dl.localPath);
});
console.log('total:', candidates.length);
