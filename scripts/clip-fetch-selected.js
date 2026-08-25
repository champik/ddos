#!/usr/bin/env node
// DDOS Harry Potter meme-trailer — CLIP_FETCH
// Downloads the ONE approved clip per matches.json entry — the only clips that
// ever get a full video file written to the project directory (candidates/'s
// phrases.json never keeps videos, see streamer-phrase-index.js).
//
// Usage: node scripts/clip-fetch-selected.js <runId>
//
// Reads:  <projectDir>/matches.json
//         [{sceneId, role, streamer, clipId, timestamp:{start,end}, quote}]
//         <projectDir>/candidates/<streamer>/phrases.json   (for clip url lookup)
// Writes: <projectDir>/selected/<NN>_<role>_<streamer>_<idSuffix>.mp4

'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonSafe } = require('./lib/state');
const { tryDownload, isValidMp4 } = require('./lib/download');
const { sanitizeStreamer, idSuffix } = require('./lib/clip-naming');
const { getProjectDir } = require('./lib/project-path');

const [,, runId] = process.argv;
if (!runId) { console.error('Usage: node scripts/clip-fetch-selected.js <runId>'); process.exit(1); }

const PROJECT_DIR = getProjectDir(runId);
const CANDIDATES_DIR = path.join(PROJECT_DIR, 'candidates');
const SELECTED_DIR = path.join(PROJECT_DIR, 'selected');

function findClipUrl(streamer, clipId) {
  const phrases = readJsonSafe(path.join(CANDIDATES_DIR, streamer, 'phrases.json'), []);
  const entry = phrases.find(p => p.clipId === clipId);
  return entry ? entry.url : null;
}

async function downloadOne(match, nn) {
  const url = findClipUrl(match.streamer, match.clipId);
  if (!url) {
    console.error(`  [MISSING] ${match.sceneId} (${match.role}/${match.streamer}): clipId ${match.clipId} not found in phrases.json`);
    return { match, status: 'missing-url' };
  }

  const basename = `${String(nn).padStart(2, '0')}_${sanitizeStreamer(match.role)}_${sanitizeStreamer(match.streamer)}_${idSuffix(match.clipId)}`;
  const outPath = path.join(SELECTED_DIR, `${basename}.mp4`);

  if (fs.existsSync(outPath) && await isValidMp4(outPath)) {
    console.log(`  [SKIP] ${basename}.mp4 already downloaded`);
    return { match, status: 'skipped', filename: `${basename}.mp4` };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, 1500 * attempt));
    const result = await tryDownload(url, outPath);
    if (result.ok) {
      console.log(`  [OK] ${basename}.mp4`);
      return { match, status: 'ok', filename: `${basename}.mp4` };
    }
    console.warn(`  [RETRY ${attempt}] ${basename}.mp4: ${result.stderr}`);
  }
  return { match, status: 'error' };
}

async function main() {
  const matches = readJsonSafe(path.join(PROJECT_DIR, 'matches.json'), []);
  if (!Array.isArray(matches) || matches.length === 0) {
    console.error('[CLIP-FETCH] matches.json is empty or missing — approve phrase matches first.');
    process.exit(1);
  }

  fs.mkdirSync(SELECTED_DIR, { recursive: true });
  console.log(`[CLIP-FETCH] ${matches.length} approved matches`);

  const results = [];
  for (let i = 0; i < matches.length; i++) {
    results.push(await downloadOne(matches[i], i + 1));
  }

  const ok = results.filter(r => r.status === 'ok' || r.status === 'skipped');
  const errors = results.filter(r => r.status !== 'ok' && r.status !== 'skipped');
  console.log(`\n[CLIP-FETCH] done: ${ok.length}/${matches.length} ready in selected/, ${errors.length} failed`);
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
