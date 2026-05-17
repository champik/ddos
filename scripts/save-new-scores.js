'use strict';
const fs = require('fs');

const newClips = require('./_new-chill-clips.json');

const scores = [
  { clipId: 'SullenFurryAubergineDancingBanana-Y-beJc7FJL3AwPSM', retentionScore: 42, funnyScore: 20, payoffStrength: 38, contextClarity: 48, noveltyScore: 52, shortsPotential: 35, longFormPotential: 52, transitionPotential: 20, cooldownPotential: 78, musicRisk: 35, toxicityRisk: 0, singingScore: 85, dancingScore: 5, rageScore: 0, flags: [], reasoning: 'Original heartfelt song, clear chill finale candidate' },
  { clipId: 'TacitSecretiveLousePoooound-IQ9THJwjhLob5Npb', retentionScore: 30, funnyScore: 35, payoffStrength: 28, contextClarity: 22, noveltyScore: 38, shortsPotential: 22, longFormPotential: 22, transitionPotential: 18, cooldownPotential: 38, musicRisk: 55, toxicityRisk: 0, singingScore: 25, dancingScore: 8, rageScore: 0, flags: [], reasoning: 'Unclear performance, low views' },
  { clipId: 'AdorableSpunkyYakSeemsGood-gmcx5pCUr3rArtpg', retentionScore: 48, funnyScore: 15, payoffStrength: 42, contextClarity: 52, noveltyScore: 56, shortsPotential: 38, longFormPotential: 58, transitionPotential: 18, cooldownPotential: 82, musicRisk: 30, toxicityRisk: 0, singingScore: 80, dancingScore: 5, rageScore: 0, flags: [], reasoning: 'Beautiful mbira cover, genuine chill vibe' },
  { clipId: 'ConfidentStylishCodBigBrother-1RTdVJRJWPL1f7Zt', retentionScore: 35, funnyScore: 30, payoffStrength: 28, contextClarity: 28, noveltyScore: 32, shortsPotential: 22, longFormPotential: 28, transitionPotential: 18, cooldownPotential: 42, musicRisk: 42, toxicityRisk: 0, singingScore: 42, dancingScore: 5, rageScore: 5, flags: [], reasoning: 'Context unclear, performance quality unknown' },
  { clipId: 'EmpathicMushyInternDendiFace-NkS4DxsBoQY8tvJM', retentionScore: 52, funnyScore: 8, payoffStrength: 48, contextClarity: 38, noveltyScore: 55, shortsPotential: 22, longFormPotential: 60, transitionPotential: 18, cooldownPotential: 82, musicRisk: 25, toxicityRisk: 0, singingScore: 52, dancingScore: 5, rageScore: 0, flags: [], reasoning: 'Skilled piano cover of Castlevania, calming' },
  { clipId: 'ThirstyYummyKangarooJonCarnage-2zXZ7PTc1XhoussG', retentionScore: 50, funnyScore: 5, payoffStrength: 45, contextClarity: 35, noveltyScore: 50, shortsPotential: 18, longFormPotential: 62, transitionPotential: 15, cooldownPotential: 85, musicRisk: 32, toxicityRisk: 0, singingScore: 52, dancingScore: 5, rageScore: 0, flags: [], reasoning: 'Beautiful Enya piano cover, serene' },
  { clipId: 'OpenPowerfulTrollHassaanChop-BaBi4iVJFSA9LRsS', retentionScore: 22, funnyScore: 18, payoffStrength: 18, contextClarity: 18, noveltyScore: 25, shortsPotential: 12, longFormPotential: 18, transitionPotential: 8, cooldownPotential: 32, musicRisk: 28, toxicityRisk: 0, singingScore: 38, dancingScore: 5, rageScore: 0, flags: ['non_english'], reasoning: 'Filipino language birthday song, no context for English audience' },
  { clipId: 'HungryTallDeerCclamChamp-cFqqgb5Ig2pdDvLL', retentionScore: 55, funnyScore: 68, payoffStrength: 52, contextClarity: 58, noveltyScore: 55, shortsPotential: 52, longFormPotential: 52, transitionPotential: 38, cooldownPotential: 48, musicRisk: 42, toxicityRisk: 5, singingScore: 8, dancingScore: 5, rageScore: 8, flags: [], reasoning: 'DJ brown note joke, producer testing sounds, genuinely funny' },
  { clipId: 'VastBrightMoonLeeroyJenkins-wMR4EJa63mxcXG_s', retentionScore: 45, funnyScore: 35, payoffStrength: 38, contextClarity: 42, noveltyScore: 52, shortsPotential: 32, longFormPotential: 42, transitionPotential: 22, cooldownPotential: 38, musicRisk: 18, toxicityRisk: 5, singingScore: 32, dancingScore: 5, rageScore: 0, flags: [], reasoning: 'Original rap, decent quality but small streamer' },
  { clipId: 'FantasticWimpyAubergineBatChest-jZomQNgjCWY4rr7c', retentionScore: 52, funnyScore: 62, payoffStrength: 52, contextClarity: 58, noveltyScore: 58, shortsPotential: 48, longFormPotential: 58, transitionPotential: 32, cooldownPotential: 65, musicRisk: 18, toxicityRisk: 0, singingScore: 18, dancingScore: 0, rageScore: 0, flags: [], reasoning: 'Charming Quebecois French language lesson, genuinely funny' },
  { clipId: 'PlausibleVainMagpieOhMyDog-2qyhgNHQJk9nlraA', retentionScore: 56, funnyScore: 62, payoffStrength: 52, contextClarity: 65, noveltyScore: 55, shortsPotential: 52, longFormPotential: 55, transitionPotential: 35, cooldownPotential: 60, musicRisk: 0, toxicityRisk: 0, singingScore: 0, dancingScore: 0, rageScore: 0, flags: [], reasoning: 'Wholesome fisherman following one-fish rule, clean humor' },
  { clipId: 'AntsyKawaiiPizzaUnSane-NvinPMasdxhtzxFv', retentionScore: 65, funnyScore: 75, payoffStrength: 72, contextClarity: 55, noveltyScore: 60, shortsPotential: 70, longFormPotential: 65, transitionPotential: 50, cooldownPotential: 28, musicRisk: 0, toxicityRisk: 28, singingScore: 0, dancingScore: 0, rageScore: 0, flags: ['tourette_tics'], reasoning: 'Sweet_Anita Tourette tic then serious no-spoilers, absurdly funny contrast' },
  { clipId: 'PlayfulLaconicDotterelDancingBaby-JuZ492Y64_oZLBZJ', retentionScore: 52, funnyScore: 62, payoffStrength: 50, contextClarity: 42, noveltyScore: 45, shortsPotential: 58, longFormPotential: 48, transitionPotential: 38, cooldownPotential: 40, musicRisk: 0, toxicityRisk: 8, singingScore: 5, dancingScore: 0, rageScore: 0, flags: [], reasoning: 'Jinnytty caught moment, funny title' },
  { clipId: 'AstuteLightManateeKreygasm-Y9o2_knZ5DecbGI4', retentionScore: 46, funnyScore: 45, payoffStrength: 42, contextClarity: 52, noveltyScore: 52, shortsPotential: 40, longFormPotential: 52, transitionPotential: 25, cooldownPotential: 66, musicRisk: 32, toxicityRisk: 0, singingScore: 15, dancingScore: 0, rageScore: 0, flags: [], reasoning: 'Streamer in awe of game music, wholesome' },
  { clipId: 'EnjoyableRockyScallionArsonNoSexy-hoUnbctpTkZWwbdm', retentionScore: 50, funnyScore: 55, payoffStrength: 45, contextClarity: 42, noveltyScore: 45, shortsPotential: 50, longFormPotential: 42, transitionPotential: 32, cooldownPotential: 38, musicRisk: 0, toxicityRisk: 10, singingScore: 0, dancingScore: 0, rageScore: 5, flags: [], reasoning: 'Vtuber learns new word for partner, short sweet' },
  { clipId: 'ManlyCautiousGarageCoolStoryBob-6LZY4kR-U6vUv1tu', retentionScore: 60, funnyScore: 65, payoffStrength: 55, contextClarity: 50, noveltyScore: 42, shortsPotential: 55, longFormPotential: 55, transitionPotential: 40, cooldownPotential: 32, musicRisk: 0, toxicityRisk: 10, singingScore: 5, dancingScore: 0, rageScore: 10, flags: [], reasoning: 'xQc Drake vs Katy Perry hot-take, entertaining commentary' },
  { clipId: 'ImportantBigOrangeTriHard-1wUXJMJGDTcHH0k9', retentionScore: 60, funnyScore: 38, payoffStrength: 55, contextClarity: 52, noveltyScore: 50, shortsPotential: 68, longFormPotential: 52, transitionPotential: 22, cooldownPotential: 72, musicRisk: 42, toxicityRisk: 0, singingScore: 8, dancingScore: 82, rageScore: 0, flags: [], reasoning: 'Emiru dancing to cinema moment, perfect dancing finale candidate' },
  { clipId: 'ArtsyBraveWeaselFloof-d7RGgPeDkD_bAF3l', retentionScore: 50, funnyScore: 55, payoffStrength: 45, contextClarity: 38, noveltyScore: 42, shortsPotential: 48, longFormPotential: 42, transitionPotential: 32, cooldownPotential: 28, musicRisk: 0, toxicityRisk: 5, singingScore: 0, dancingScore: 0, rageScore: 5, flags: [], reasoning: 'Jasontheween farm story, decent but needs context' },
  { clipId: 'SillyFamousLorisNotATK-L0V_oUxMnukDajWD', retentionScore: 28, funnyScore: 38, payoffStrength: 28, contextClarity: 18, noveltyScore: 30, shortsPotential: 18, longFormPotential: 22, transitionPotential: 12, cooldownPotential: 28, musicRisk: 0, toxicityRisk: 22, singingScore: 0, dancingScore: 0, rageScore: 0, flags: ['non_english'], reasoning: 'Portuguese language, audience will not understand' },
  { clipId: 'RespectfulDoubtfulSkirretYee-PdpYvAsPb0hsTu2Z', retentionScore: 32, funnyScore: 28, payoffStrength: 28, contextClarity: 18, noveltyScore: 32, shortsPotential: 18, longFormPotential: 22, transitionPotential: 12, cooldownPotential: 28, musicRisk: 0, toxicityRisk: 0, singingScore: 0, dancingScore: 0, rageScore: 0, flags: ['non_english'], reasoning: 'German goldfish metaphor, no value for English audience' },
];

function ddosScore(s) {
  return s.retentionScore * 0.30
    + s.funnyScore * 0.25
    + s.payoffStrength * 0.20
    + s.contextClarity * 0.15
    + s.noveltyScore * 0.10
    - (s.musicRisk > 60 ? (s.musicRisk - 60) * 0.3 : 0)
    - (s.toxicityRisk > 40 ? (s.toxicityRisk - 40) * 0.5 : 0);
}

const newClipMap = {};
newClips.forEach(c => { newClipMap[c.id] = c; });

scores.forEach(s => {
  const clip = newClipMap[s.clipId];
  if (!clip) { console.log('Missing clip:', s.clipId); return; }
  const full = { ...s, ddosScore: ddosScore(s) };
  const dir = 'projects/Episode_2_2026_05_17/processed/' + s.clipId;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/score.json', JSON.stringify(full, null, 2));
});

const scoredPath = 'projects/Episode_2_2026_05_17/clips/scored-clips.json';
const existing = JSON.parse(fs.readFileSync(scoredPath, 'utf8'));
const existingIds = new Set(existing.map(c => c.id));

const newScored = scores.map(s => {
  const clip = newClipMap[s.clipId];
  return {
    id: s.clipId,
    broadcaster_name: clip ? clip.broadcaster_name : '',
    game_name: clip ? clip.game_name : '',
    language: clip ? clip.language : '',
    duration: clip ? clip.duration : 0,
    view_count: clip ? clip.view_count : 0,
    title: clip ? clip.title : '',
    ...s,
    ddosScore: ddosScore(s)
  };
}).filter(c => !existingIds.has(c.id));

fs.writeFileSync(scoredPath, JSON.stringify([...existing, ...newScored], null, 2));

console.log('Scores saved to scored-clips.json');
console.log('\nChill candidates (singingScore > 70 or dancingScore > 70):');
newScored.filter(c => c.singingScore > 70 || c.dancingScore > 70).forEach(c => {
  console.log('  ' + c.broadcaster_name.padEnd(20) + ' ddos=' + c.ddosScore.toFixed(1) + '  singing=' + c.singingScore + '  dancing=' + c.dancingScore + '  "' + c.title + '"');
});

console.log('\nTop new clips by ddosScore:');
newScored.sort((a,b) => b.ddosScore - a.ddosScore).slice(0, 8).forEach((c,i) => {
  console.log('  [' + (i+1) + '] ' + c.broadcaster_name.padEnd(20) + ' ddos=' + c.ddosScore.toFixed(1) + '  singing=' + c.singingScore + '  dancing=' + c.dancingScore);
});
