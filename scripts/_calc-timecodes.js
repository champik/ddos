'use strict';
const fs = require('fs');
const { execSync } = require('child_process');
const plan = require('../projects/Episode_2_2026_05_17/edit/episode-plan.json');
const scored = require('../projects/Episode_2_2026_05_17/clips/scored-clips.json');

const INTRO_DUR = 1.25;
const RECONNECT_DUR = 2.0;

const scoreMap = {};
scored.forEach(s => { scoreMap[s.id] = s; });

function fmt(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

const chillIds = new Set([
  plan.chillPlan.singingClipId,
  ...(plan.chillPlan.dancingClipIds || [])
]);

const chapters = [];
let t = 0;

for (let gi = 0; gi < plan.groups.length; gi++) {
  const g = plan.groups[gi];
  const clipsToUse = g.clipIds.filter(id => !chillIds.has(id));
  if (clipsToUse.length === 0) continue;

  if (gi > 0) t += RECONNECT_DUR;

  let lastBroadcaster = null;
  for (const clipId of clipsToUse) {
    const s = scoreMap[clipId];
    const broadcaster = s ? s.broadcaster_name : '?';
    const cleanPath = 'projects/Episode_2_2026_05_17/processed/' + clipId + '/clean.mp4';
    let dur = 0;
    try {
      const out = execSync('ffprobe -v quiet -show_entries format=duration -of csv=p=0 ' + cleanPath, { encoding: 'utf8' }).trim();
      dur = parseFloat(out);
    } catch (e) {}

    const isFirst = gi === 0 && lastBroadcaster === null;
    if (broadcaster !== lastBroadcaster) {
      chapters.push({ t: isFirst ? 0 : t, broadcaster });
    }
    lastBroadcaster = broadcaster;
    t += dur;
  }
}

console.log('=== CHAPTERS ===');
chapters.forEach(c => console.log(fmt(c.t) + ' ' + c.broadcaster));
console.log('\nTotal clip duration: ' + t.toFixed(1) + 's (' + (t / 60).toFixed(1) + ' min)');

const chaptersStr = chapters.map(c => fmt(c.t) + ' ' + c.broadcaster).join('\n');
const baseHashtags = '#DailyDoseOfStream #TwitchClips #Streaming #JustChatting #IRL #Twitch #TwitchHighlights #StreamerMoments';
const streamerTags = [...new Set(plan.groups.flatMap(g => g.clipIds.map(id => scoreMap[id] && scoreMap[id].broadcaster_name)).filter(Boolean))];
const topStreamers = streamerTags.slice(0, 5).map(s => '#' + s.replace(/\s/g, '')).join(' ');
const description = 'Your daily dose of the best Twitch moments.\n\n' + chaptersStr + '\n\n' + baseHashtags + ' ' + topStreamers;

console.log('\n=== DESCRIPTION ===');
console.log(description);
