#!/usr/bin/env node
'use strict';
const fs   = require('fs');
const path = require('path');
const { readJson } = require('./lib/state');
const { getProjectDir } = require('./lib/project-path');
const { getDuration, hasAudioStream, hasVideoStream, analyzeSilence, hasMuteGap } = require('./lib/media-probe');
const { clipSequence, reconnectAfterSet } = require('./lib/timeline');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node scripts/build-concat.js <runId>'); process.exit(1); }
const projectDir = path.resolve(getProjectDir(runId));
const editorial  = readJson(path.join(projectDir, 'edit/editorial.json'));

// reconnectAfterSet unions reconnectPositions with '__recon' markers in
// clipOrder into one clipId-keyed Set — so a seam recorded both ways (e.g. a
// reconnectPositions entry AND an adjacent '__recon' token for the same clip)
// still only inserts reconnecting.mp4 once. Walking clipOrder's raw '__recon'
// tokens as a second, independent insertion trigger (as this used to do) let
// the same seam double-insert.
const reconnectSet = reconnectAfterSet(editorial);
const clipOrder = clipSequence(editorial);
const introPath     = path.resolve('assets/intro/intro_30fps.mp4').replace(/\\/g, '/');
const outroPath     = path.resolve('assets/outro/outro_30fps.mp4').replace(/\\/g, '/');
const reconnectFile = path.resolve(projectDir, 'edit/reconnecting.mp4');
const reconnectPath = reconnectFile.replace(/\\/g, '/');

const MIN_RECON_DUR = 0.8;
const MUTE_GAP_SEC  = 3.0; // коротші провали — звичайні паузи в мовленні

// Перебивка мусить бути придатною, а не просто існувати: файл на 0.04s
// (наслідок -ss за кінець кліпу) проходив колишню перевірку fs.existsSync
// і потрапляв у відео, зсуваючи все, що йде після нього.
function reconnectProblem(file) {
  if (!fs.existsSync(file)) return 'файл відсутній';
  const dur = getDuration(file);
  if (dur < MIN_RECON_DUR) return `тривалість ${dur.toFixed(2)}s < ${MIN_RECON_DUR}s`;
  if (!hasVideoStream(file)) return 'немає відео-доріжки';
  if (!hasAudioStream(file)) return 'немає аудіо-доріжки';
  return null;
}

const reconIssue = reconnectProblem(reconnectFile);
const reconnectUsable = reconIssue === null;
if (!reconnectUsable) console.warn(`[RECONNECT] пропускаю перебивку: ${reconIssue}`);

// Кожен сегмент мусить нести звук. Без аудіо-доріжки concat -c copy у
// render-final.js ламає звук усього епізоду — і робить це мовчки, з кодом 0.
// Тиша всередині доріжки сюди ж: DMCA-мют і битий мердж лишають стрім на місці.
const audioIssues = [];
function checkSegmentAudio(file, label) {
  if (!hasAudioStream(file)) {
    audioIssues.push({ label, fatal: true, reason: 'немає аудіо-доріжки' });
    return;
  }
  const sil = analyzeSilence(file);
  if (!sil) return; // не змогли виміряти — не блокуємо
  if (sil.silentRatio >= 0.98) {
    audioIssues.push({ label, fatal: false, reason: `повністю німий (max RMS ${sil.maxRms.toFixed(1)} dB)` });
  } else if (hasMuteGap(sil, MUTE_GAP_SEC)) {
    audioIssues.push({ label, fatal: false, reason: `${sil.longestMuteSec.toFixed(1)}s суцільної тиші` });
  }
}

const lines = [];
lines.push("file '" + introPath + "'");

for (const clipId of clipOrder) {
  const overlayed = path.resolve(projectDir, 'processed', clipId, 'overlayed.mp4');
  const clean     = path.resolve(projectDir, 'processed', clipId, 'clean.mp4');
  const src = fs.existsSync(overlayed) ? overlayed : clean;
  if (!fs.existsSync(src)) { console.warn('MISSING:', clipId); continue; }
  checkSegmentAudio(src, clipId);
  lines.push("file '" + src.replace(/\\/g, '/') + "'");
  if (reconnectSet.has(clipId) && reconnectUsable) {
    lines.push("file '" + reconnectPath + "'");
  }
}

lines.push("file '" + outroPath + "'");

if (audioIssues.length > 0) {
  console.warn(`\n[AUDIO] проблеми зі звуком у ${audioIssues.length} сегм.:`);
  audioIssues.forEach(i => console.warn(`  ${i.fatal ? '✗' : '⚠'} ${i.label}: ${i.reason}`));
}

const fatal = audioIssues.filter(i => i.fatal);
if (fatal.length > 0) {
  console.error(`\n[AUDIO] ${fatal.length} сегм. без аудіо-доріжки — concat -c copy зламає звук усього епізоду.`);
  console.error('Перезапусти APPLY_EDITORIAL для цих кліпів або прибери їх з clipOrder.');
  process.exit(1);
}

const outPath = path.join(projectDir, 'edit/concat-list.txt');
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log('Written: ' + outPath + ' (' + lines.length + ' entries)');
