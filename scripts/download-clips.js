#!/usr/bin/env node
// DDOS Pipeline — DOWNLOAD
// Usage: node scripts/run-download.js <runId>

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const [,, runId] = process.argv;
const RUN_DIR = path.join('projects', runId);
const CLIPS_DIR = path.join(RUN_DIR, 'clips');
const DOWNLOADS_DIR = path.join(RUN_DIR, 'downloads');
const MAX_PARALLEL = 5;

function buildFilename(clip) {
  const cat = (clip.game_name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const streamer = (clip.broadcaster_name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  const views = clip.view_count;
  const date = (clip.created_at || '').slice(0, 10).replace(/-/g, '_');
  return `${cat}_${streamer}_${views}_${date}.mp4`;
}

function downloadClip(clip) {
  return new Promise((resolve) => {
    const filename = buildFilename(clip);
    const outPath = path.join(DOWNLOADS_DIR, filename);

    if (fs.existsSync(outPath)) {
      resolve({ clip, filename, status: 'skipped' });
      return;
    }

    const url = clip.url;
    const proc = spawn('python', ['-m', 'yt_dlp',
      '--no-playlist',
      '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--output', outPath,
      '--quiet',
      '--no-warnings',
      url
    ]);

    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outPath)) {
        resolve({ clip, filename, status: 'ok' });
      } else {
        resolve({ clip, filename, status: 'error', error: stderr.slice(0, 200) });
      }
    });
    proc.on('error', e => resolve({ clip, filename, status: 'error', error: e.message }));
  });
}

async function runParallel(tasks, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const main100 = JSON.parse(fs.readFileSync(path.join(CLIPS_DIR, 'prescore-candidates.json'), 'utf8'));
  const benchExtraPath = path.join(CLIPS_DIR, 'bench-extra.json');
  const benchExtra = fs.existsSync(benchExtraPath) ? JSON.parse(fs.readFileSync(benchExtraPath, 'utf8')) : [];
  const candidates = [...main100, ...benchExtra];
  console.log(`[DOWNLOAD] ${main100.length} main + ${benchExtra.length} bench clips to download (max parallel: ${MAX_PARALLEL})`);

  const tasks = candidates.map((clip, i) => () => {
    process.stdout.write(`\r  ${i+1}/${candidates.length} ...`);
    return downloadClip(clip);
  });

  const results = await runParallel(tasks, MAX_PARALLEL);
  console.log('');

  const ok = results.filter(r => r.status === 'ok');
  const skipped = results.filter(r => r.status === 'skipped');
  const errors = results.filter(r => r.status === 'error');

  console.log(`[DOWNLOAD] ok=${ok.length}, skipped=${skipped.length}, errors=${errors.length}`);
  if (errors.length > 0) {
    console.log('[DOWNLOAD] Errors:');
    errors.forEach(r => console.log(`  ${r.clip.broadcaster_name}: ${r.error}`));
  }

  // Build downloaded-clips.json with localPath
  const downloaded = results
    .filter(r => r.status === 'ok' || r.status === 'skipped')
    .map(r => ({ ...r.clip, localPath: path.join(RUN_DIR, 'downloads', r.filename).replace(/\\/g, '/') }));

  fs.writeFileSync(path.join(CLIPS_DIR, 'downloaded-clips.json'), JSON.stringify(downloaded, null, 2));

  const state = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'state.json'), 'utf8'));
  state.counts.downloaded = downloaded.length;
  state.stages.download = 'done';
  fs.writeFileSync(path.join(RUN_DIR, 'state.json'), JSON.stringify(state, null, 2));

  console.log(`[DOWNLOAD] Done. ${downloaded.length} clips saved to downloaded-clips.json`);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
