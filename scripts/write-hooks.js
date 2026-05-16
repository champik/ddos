#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node write-hooks.js <runId>'); process.exit(1); }

const projectDir = path.join('projects', runId);
const processedDir = path.join(projectDir, 'processed');

const hooks = {
  'LongRamshackleBeanJKanStyle-3Des94HRrC4cq1a7':   'WAIT FOR IT',
  'PunchyHyperWebAllenHuhu-ujCtLippMQmWU54c':        'THE MATTRESS WINS',
  'PlausibleVainMagpieOhMyDog-2qyhgNHQJk9nlraA':     'THE MOST RESPONSIBLE STREAMER',
  'TrappedPlausibleCrowGingerPower-g8zEaZqG3nh1UdOT':'SHE JUST SAW THE NUMBERS',
  'DrabSaltyOwlBigBrother-dDbFed6ywzo-XCxa':         'SOMETHING IS COMING',
  'RoughSlickTubersCharlietheUnicorn-kj7aX_8mFCBvaKav': 'THAT ONE HURT',
  'PlumpFuriousWitchTF2John-DS5MA-c62pFBnsrt':       'INTERESTING THEORY',
  'ObservantFurtiveTruffleItsBoshyTime-h41rocXR9NI3DzsX': 'HE USES FULL NAMES',
  'CuteVastHawkTheTarFu-DzvmkIVgPLImvDnk':           'BATHROOM IS OCCUPIED',
  'PreciousTiredWeaselAsianGlow--airkCp1AwBK34sW':   'SOMETHING GOT WET',
  'LuckyGoldenVelociraptorCmonBruh-bWTptMPnMbs0iid2':'NATURE SAID NO',
  'SweetWimpyAmazonSwiftRage-K9lufVK94oLviiL6':      'SHE ACTUALLY DID IT',
  'BrightMoldyKaleArgieB8-f5AH46OxxPhusrBa':         'THE CASTER HAS NO WORDS',
  'EndearingOilyHerbsItsBoshyTime-BZhwWLwDioF1esvD': 'THIS SHOULD NOT BE POSSIBLE',
  'SlipperyBlatantCaribouCoolStoryBro-TdY2zWM4D89FjTBn': 'VALID EXCUSE ACTUALLY',
  'CourageousPerfectDotterelMoreCowbell-61t-mPViBTAZVOCN': 'NOT THEIR FAULT',
  'SmilingResilientWoodcockPRChase-ThZ9njpNj9dDEydC': 'THE STORE HEARD THE NAME',
  'TenderTsundereLaptopLeeroyJenkins-uH5haueaVS5DPzsM': 'SUBNAUTICA SAYS NO',
  'FurtiveSmoothTrianglePeoplesChamp-02-j6GiCyj5mSW6v': 'DID NOT SEE THAT COMING',
  'DeadSplendidAniseSeemsGood--7bNn2qTweTC7qDM':     'JUST A SCRATCH',
  'MotionlessAgreeableRamenTTours-R-VuPdtLOwLvAQMi': 'BIG ANNOUNCEMENT',
  'AnimatedVainTrollWow-2FjmoooF-yLXrjvr':           'SECURITY MISSED THIS',
  'ResoluteConfidentCockroachBrokeBack-wQnDPxV6MF1S7442': 'SHE FOUND THE VIBE'
};

let written = 0;
for (const [clipId, hook] of Object.entries(hooks)) {
  const dir = path.join(processedDir, clipId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hook.txt'), hook);
  console.log(`  ${clipId.slice(0, 30).padEnd(30)} → ${hook}`);
  written++;
}

const statePath = path.join(projectDir, 'state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.stages.plan = 'done';
state.stages.hooks = 'done';
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log(`\n${written} hooks written.`);
