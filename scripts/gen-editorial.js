// generate-editorial: builds edit/edit.html from scored-clips.json + template
const fs = require('fs');
const path = require('path');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node scripts/gen-editorial.js <runId>'); process.exit(1); }

const projectDir = path.join('projects', runId);
const scoredPath = path.join(projectDir, 'clips', 'scored-clips.json');
const templatePath = path.join('assets', 'editorial', 'edit-template.html');
const outDir = path.join(projectDir, 'edit');
const outPath = path.join(outDir, 'edit.html');

if (!fs.existsSync(scoredPath)) { console.error('scored-clips.json not found'); process.exit(1); }

const scored = JSON.parse(fs.readFileSync(scoredPath, 'utf8'));
const template = fs.readFileSync(templatePath, 'utf8');

// Parse runId for episode number
const epMatch = runId.match(/Episode_(\d+)/);
const episodeNumber = epMatch ? parseInt(epMatch[1]) : 0;

// Build clip object for UI
function buildClip(c) {
  const filename = path.basename(c.localPath || '');
  return {
    id: c.id,
    streamer: c.broadcaster_name,
    category: c.game_name,
    gameId: c.game_id,
    duration: c.duration,
    ddosScore: c.ddosScore,
    funnyScore: c.funnyScore,
    retentionScore: c.retentionScore,
    payoffStrength: c.payoffStrength,
    contextClarity: c.contextClarity,
    noveltyScore: c.noveltyScore,
    shortsPotential: c.shortsPotential,
    thumbnailPotential: c.thumbnailPotential,
    toxicityRisk: c.toxicityRisk,
    singingScore: c.singingScore,
    dancingScore: c.dancingScore,
    rageScore: c.rageScore,
    emotionalCategory: c.emotionalCategory,
    flags: c.flags || [],
    reasoning: c.reasoning,
    videoPath: '../downloads/' + filename,
    title: c.title,
    viewCount: c.view_count,
    language: c.language,
    viralityRatio: c.viralityRatio
  };
}

// Selection logic
const CHILL_SINGING = 70;
const MAX_PER_STREAMER = 3;
const TARGET_MIN = 720;
const TARGET_MAX = 900;

// Separate chill clips (singing>70)
const chillClips = scored.filter(c => (c.singingScore||0) > CHILL_SINGING && c.toxicityRisk < 40);
const mainPool = scored.filter(c => !((c.singingScore||0) > CHILL_SINGING && c.toxicityRisk < 40));

// Reject hard-flagged clips
const flaggedIds = new Set(
  scored.filter(c => (c.flags||[]).some(f => ['antisemitic_slur','racist_remark'].includes(f))).map(c => c.id)
);

const selectableMain = mainPool.filter(c => !flaggedIds.has(c.id));
selectableMain.sort((a,b) => b.ddosScore - a.ddosScore);

// Build selected: top clips, max 3 per streamer, target 720-900s raw
const selected = [];
const streamerCount = {};
let totalDur = 0;

// Prefer JC/IRL clips — boost them slightly in ordering by processing JC/IRL first for balance
const jcIrlIds = new Set(['509658', '509672']);
const jcIrlPool = selectableMain.filter(c => jcIrlIds.has(c.game_id));
const gamingPool = selectableMain.filter(c => !jcIrlIds.has(c.game_id));

// Interleave: take from both pools proportionally (target 50% JC/IRL)
// Simple approach: merge sorted list but JC/IRL gets slight priority
const merged = [];
let ji = 0, gi = 0;
while (ji < jcIrlPool.length || gi < gamingPool.length) {
  // Add up to 1 JC/IRL for every 1 gaming, until we have enough
  if (ji < jcIrlPool.length) merged.push(jcIrlPool[ji++]);
  if (gi < gamingPool.length) merged.push(gamingPool[gi++]);
}

// Deduplicate (same clip may not appear twice, but just in case)
const seen = new Set();
const orderedPool = [];
for (const c of merged) {
  if (!seen.has(c.id)) { seen.add(c.id); orderedPool.push(c); }
}

// Select main clips
for (const c of orderedPool) {
  const sc = streamerCount[c.broadcaster_name] || 0;
  if (sc >= MAX_PER_STREAMER) continue;
  if (totalDur >= TARGET_MAX) break;
  selected.push(c);
  streamerCount[c.broadcaster_name] = sc + 1;
  totalDur += c.duration;
}

// Add a chill clip at end if available
const bestChill = chillClips.sort((a,b) => b.ddosScore - a.ddosScore)[0];
if (bestChill) selected.push(bestChill);

const selectedIds = new Set(selected.map(c => c.id));

// Bench: all scored clips not in selected (including flagged, for editor awareness)
const bench = scored.filter(c => !selectedIds.has(c.id));

console.log(`Selected ${selected.length} clips, total raw: ${totalDur.toFixed(0)}s`);
const jcIrlCount = selected.filter(c => jcIrlIds.has(c.game_id)).length;
console.log(`JC/IRL: ${jcIrlCount}/${selected.length} = ${(jcIrlCount/selected.length*100).toFixed(0)}%`);
console.log(`Bench: ${bench.length} clips`);

const clipsJson = {
  runId,
  episodeNumber,
  selected: selected.map(buildClip),
  bench: bench.map(buildClip)
};

fs.mkdirSync(outDir, { recursive: true });
const html = template.replace('__CLIPS_JSON__', JSON.stringify(clipsJson));
fs.writeFileSync(outPath, html, 'utf8');
console.log(`\n✅ Editorial UI: ${outPath}`);
