#!/usr/bin/env node
/**
 * Download clips from prescore-candidates.json using python -m yt_dlp
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node download-clips.js <runId>'); process.exit(1); }

const projectDir = path.join('projects', runId);
const clipsDir = path.join(projectDir, 'clips');
const downloadsDir = path.join(projectDir, 'downloads');

function updateState(updates) {
  const statePath = path.join(projectDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const [key, val] of Object.entries(updates)) {
    const parts = key.split('.');
    let obj = state;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = val;
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function buildDownloadFilename(clip) {
  const cat = (clip.game_name || 'unknown').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const streamer = clip.broadcaster_name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const views = clip.view_count;
  const date = clip.created_at.slice(0, 10).replace(/-/g, '_');
  return `${cat}_${streamer}_${views}_${date}.mp4`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function downloadClip(clip) {
  const filename = buildDownloadFilename(clip);
  const outPath = path.join(downloadsDir, filename);
  if (fs.existsSync(outPath)) {
    return outPath;
  }
  const result = spawnSync('python', [
    '-m', 'yt_dlp',
    '--no-playlist',
    '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--output', outPath,
    '--quiet',
    '--no-warnings',
    clip.url
  ], { stdio: 'pipe', encoding: 'utf8', timeout: 120000 });

  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || '').slice(0, 300);
    console.error(`  FAIL: ${filename}\n    ${err}`);
    return null;
  }
  if (!fs.existsSync(outPath)) {
    console.error(`  FAIL: output not found: ${outPath}`);
    return null;
  }
  return outPath;
}

async function runInBatches(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length) await sleep(300);
  }
  return results;
}

async function main() {
  const candidates = JSON.parse(fs.readFileSync(path.join(clipsDir, 'prescore-candidates.json'), 'utf8'));
  console.log(`Downloading ${candidates.length} clips...`);
  updateState({ 'stages.download': 'running' });

  let done = 0;
  const downloadedClips = [];

  const results = await runInBatches(candidates, 5, async (clip) => {
    const localPath = await Promise.resolve(downloadClip(clip));
    done++;
    if (done % 10 === 0 || done === candidates.length) {
      process.stdout.write(`  [${done}/${candidates.length}] downloaded: ${downloadedClips.length + (localPath ? 1 : 0)}\n`);
    }
    if (localPath) return { ...clip, localPath };
    return null;
  });

  for (const r of results) {
    if (r) downloadedClips.push(r);
  }

  fs.writeFileSync(path.join(clipsDir, 'downloaded-clips.json'), JSON.stringify(downloadedClips, null, 2));
  updateState({ 'stages.download': 'done', 'counts.downloaded': downloadedClips.length });
  console.log(`\nDownloaded: ${downloadedClips.length}/${candidates.length}`);
}

main().catch(e => {
  console.error('DOWNLOAD ERROR:', e.message);
  updateState({ 'stages.download': 'failed' });
  process.exit(1);
});
