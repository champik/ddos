'use strict';
// Builds lightweight metadata required by gen-review.js when full thumbnail/metadata stage is not run yet.
// Usage: node scripts/build-review-metadata.js <projectDir>

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectDir = process.argv[2];
if (!projectDir) {
  console.error('Usage: node scripts/build-review-metadata.js <projectDir>');
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(path.join(projectDir, 'edit/episode-plan.json'), 'utf8'));
const scored = JSON.parse(fs.readFileSync(path.join(projectDir, 'clips/scored-clips.json'), 'utf8'));
const byId = Object.fromEntries(scored.map(clip => [clip.id, clip]));

function duration(clipId) {
  const file = path.join(projectDir, 'processed', clipId, 'clean.mp4');
  if (!fs.existsSync(file)) return 0;
  const result = spawnSync('ffprobe', [
    '-v', 'quiet',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    file
  ], { encoding: 'utf8' });
  return parseFloat(result.stdout) || 0;
}

function fmt(seconds) {
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function reconnectingDuration() {
  const file = path.join(projectDir, 'edit/reconnecting.mp4');
  if (!fs.existsSync(file)) return 1.0;
  const result = spawnSync('ffprobe', [
    '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file
  ], { encoding: 'utf8' });
  return parseFloat(result.stdout) || 1.0;
}

const rcDur = reconnectingDuration();
const chapters = [{ t: 0, label: 'Intro' }];
let offset = 1.25;

for (let i = 0; i < plan.groups.length; i++) {
  const group = plan.groups[i];
  chapters.push({ t: Math.round(offset), label: group.label });
  for (const clipId of group.clipIds) offset += duration(clipId);
  if (i < plan.groups.length - 1) offset += rcDur;
}

if (plan.chillPlan && plan.chillPlan.type !== 'skip') {
  chapters.push({ t: Math.round(offset), label: 'Chill Outro' });
}

const tags = [
  'DailyDoseOfStream',
  'TwitchClips',
  'Streaming',
  'JustChatting',
  'IRL',
  'Twitch',
  'TwitchHighlights',
  'StreamerMoments'
];

const shortsMetadata = (plan.shortClipIds || []).map(clipId => {
  const clip = byId[clipId] || {};
  const name = clip.broadcaster_name || 'Streamer';
  return {
    clipId,
    title: `${name} Had A Moment | Daily Dose Of Stream`,
    caption: `${name} on Daily Dose Of Stream #TwitchClips #Shorts`,
    hashtags: ['#DailyDoseOfStream', '#TwitchClips', '#Shorts']
  };
});

const metadata = {
  titleOptions: [
    'The Cobra Clip Went Completely Off Script | Daily Dose Of Stream',
    'Knossi Safari And Twitch Chaos | Daily Dose Of Stream',
    "Nobody Was Ready For Today's Twitch Clips | Daily Dose Of Stream"
  ],
  description: [
    'Your daily dose of the best Twitch moments.',
    '',
    chapters.map(chapter => `${fmt(chapter.t)} ${chapter.label}`).join('\n'),
    '',
    tags.map(tag => `#${tag}`).join(' ')
  ].join('\n'),
  tags,
  thumbnailText: 'COBRA CHAOS',
  shortsMetadata
};

fs.writeFileSync(path.join(projectDir, 'exports', 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
console.log('[OK] metadata.json written');
