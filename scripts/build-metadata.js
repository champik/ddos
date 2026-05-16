'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node build-metadata.js <projectDir>'); process.exit(1); }

const plan   = JSON.parse(fs.readFileSync(path.join(projectDir, 'edit/episode-plan.json'), 'utf8'));
const scored = JSON.parse(fs.readFileSync(path.join(projectDir, 'clips/scored-clips.json'), 'utf8'));
const state  = JSON.parse(fs.readFileSync(path.join(projectDir, 'state.json'), 'utf8'));

const scoreMap = {};
for (const c of scored) scoreMap[c.id] = c;

function getDur(clipId) {
  const p = path.join(projectDir, 'processed', clipId, 'clean.mp4');
  if (!fs.existsSync(p)) return 0;
  try {
    return parseFloat(execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${p}"`).toString().trim()) || 0;
  } catch { return 0; }
}

function fmt(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

const INTRO_DUR     = 1.25;
const RECONNECT_DUR = 1.0;

// Group labels for chapters
const groupLabels = {
  'OPENER': 'Dota 2 Tilt',
  'JC Chaos': 'Just Chatting',
  'JC Absurd': 'Streamer Chaos',
  'IRL Moments': 'IRL Moments',
  'CS2 Clutches': 'CS2 Highlights',
  'miaknightley Apex': 'Apex Legends',
  'Japan Zone': 'GTA V Japan',
  'Chaos Physics': 'Gaming Fails',
  'Wholesome Finale': 'Wholesome Clips',
};

const chapters = [{ t: 0, label: 'Intro' }];
let offset = INTRO_DUR;

for (let gi = 0; gi < plan.groups.length; gi++) {
  const g = plan.groups[gi];
  const label = groupLabels[g.label] || g.label;
  chapters.push({ t: Math.round(offset), label });

  for (const clipId of g.clipIds) {
    offset += getDur(clipId);
  }
  if (gi < plan.groups.length - 1) {
    offset += RECONNECT_DUR;
  }
}

if (plan.chillPlan && plan.chillPlan.type !== 'skip') {
  chapters.push({ t: Math.round(offset), label: 'Chill Outro' });
}

const chaptersStr = chapters.map(c => fmt(c.t) + ' ' + c.label).join('\n');

// Unique streamers for description
const allStreamers = [];
for (const g of plan.groups) {
  for (const id of g.clipIds) {
    const name = scoreMap[id]?.broadcaster_name;
    if (name && !allStreamers.includes(name)) allStreamers.push(name);
  }
}

const tags = ['DailyDoseOfStream','TwitchClips','Streaming','JustChatting','IRL','Twitch','TwitchHighlights','StreamerMoments'];

const description = `Your daily dose of the best Twitch moments.\n\n${chaptersStr}\n\n${tags.map(t => '#'+t).join(' ')}`;

const meta = {
  titleOptions: [
    "She Blamed The Mattress And It Won | Daily Dose Of Stream",
    "Nobody Was Ready For What Happened Next | Daily Dose Of Stream",
    "The Law Had Something To Say About This | Daily Dose Of Stream"
  ],
  description,
  tags,
  thumbnailText: "NOBODY SAW THIS COMING",
  shortsMetadata: [
    { clipId: 'SlipperyBlatantCaribouCoolStoryBro-TdY2zWM4D89FjTBn',  title: 'She Blamed Being A Woman | Daily Dose Of Stream', caption: 'Valid excuse actually 😂 #TwitchClips #ApexLegends #Shorts', hashtags: ['#DailyDoseOfStream','#TwitchClips','#Shorts'] },
    { clipId: 'PunchyHyperWebAllenHuhu-ujCtLippMQmWU54c',              title: 'HAchubby vs The Mattress | Daily Dose Of Stream', caption: 'The mattress wins every time 😂 #HAchubby #TwitchClips #Shorts', hashtags: ['#DailyDoseOfStream','#TwitchClips','#Shorts'] },
    { clipId: 'ObservantFurtiveTruffleItsBoshyTime-h41rocXR9NI3DzsX',  title: 'He Uses Full Names 😭 | Daily Dose Of Stream', caption: 'Did not expect this #stylishnoob4 #TwitchClips #Shorts', hashtags: ['#DailyDoseOfStream','#TwitchClips','#Shorts'] },
    { clipId: 'CuteVastHawkTheTarFu-DzvmkIVgPLImvDnk',                title: 'The Bathroom Is Occupied | Daily Dose Of Stream', caption: 'IRL content hits different 🟢 #TwitchClips #IRL #Shorts', hashtags: ['#DailyDoseOfStream','#TwitchClips','#Shorts'] },
    { clipId: 'DrabSaltyOwlBigBrother-dDbFed6ywzo-XCxa',              title: 'Beer Rant Then This Happened | Daily Dose Of Stream', caption: 'Nobody saw the sneeze coming 😂 #TwitchClips #JustChatting #Shorts', hashtags: ['#DailyDoseOfStream','#TwitchClips','#Shorts'] },
    { clipId: 'BrightMoldyKaleArgieB8-f5AH46OxxPhusrBa',              title: 'French Caster Completely Loses It | Daily Dose Of Stream', caption: 'The caster has no words 🎙️ #CS2 #TwitchClips #Shorts', hashtags: ['#DailyDoseOfStream','#CS2','#Shorts'] },
    { clipId: 'TrappedPlausibleCrowGingerPower-g8zEaZqG3nh1UdOT',      title: 'She Just Saw The Sub Count | Daily Dose Of Stream', caption: 'Pure joy 🥰 #TwitchClips #JustChatting #Shorts', hashtags: ['#DailyDoseOfStream','#TwitchClips','#Shorts'] },
    { clipId: 'PreciousTiredWeaselAsianGlow--airkCp1AwBK34sW',        title: 'Something Got Very Wet | Daily Dose Of Stream', caption: 'IRL be wild 💦 #TwitchClips #IRL #Shorts', hashtags: ['#DailyDoseOfStream','#TwitchClips','#Shorts'] },
    { clipId: 'SweetWimpyAmazonSwiftRage-K9lufVK94oLviiL6',           title: 'She Actually Did It | Daily Dose Of Stream', caption: 'Ice bath season 🥶 #Naguura #TwitchClips #Shorts', hashtags: ['#DailyDoseOfStream','#TwitchClips','#Shorts'] }
  ]
};

const outPath = path.join(projectDir, 'exports/metadata.json');
fs.writeFileSync(outPath, JSON.stringify(meta, null, 2));
console.log('[OK] metadata.json written');
console.log('\nTitles:');
meta.titleOptions.forEach((t, i) => console.log(`  [${i+1}] ${t}`));
console.log('\nChapters:');
console.log(chaptersStr);
console.log('\nthumbnailText:', meta.thumbnailText);
