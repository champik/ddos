#!/usr/bin/env node
// DDOS Pipeline — DOWNLOAD
// Usage: node scripts/run-download.js <runId>

const fs = require('fs');
const path = require('path');
const { readJson, updateState } = require('./lib/state');
const { downloadClip, runParallel } = require('./lib/download');
const { getProjectDir } = require('./lib/project-path');

const [,, runId] = process.argv;
const RUN_DIR = getProjectDir(runId);
const CLIPS_DIR = path.join(RUN_DIR, 'clips');
const DOWNLOADS_DIR = path.join(RUN_DIR, 'downloads');
const MAX_PARALLEL = 5;

async function main() {
  const candidates = readJson(path.join(CLIPS_DIR, 'prescore-candidates.json'));
  console.log(`[DOWNLOAD] ${candidates.length} clips to download (max parallel: ${MAX_PARALLEL})`);

  const tasks = candidates.map((clip, i) => () => {
    process.stdout.write(`\r  ${i + 1}/${candidates.length} ...`);
    return downloadClip(clip, DOWNLOADS_DIR);
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

  const downloaded = results
    .filter(r => r.status === 'ok' || r.status === 'skipped')
    .map(r => ({ ...r.clip, localPath: path.join(RUN_DIR, 'downloads', r.filename).replace(/\\/g, '/') }));

  fs.writeFileSync(path.join(CLIPS_DIR, 'downloaded-clips.json'), JSON.stringify(downloaded, null, 2));

  updateState(RUN_DIR, s => {
    s.counts.downloaded = downloaded.length;
    s.stages.download = errors.length === 0 ? 'done'
      : (downloaded.length === 0 ? 'failed' : 'done_with_errors');
  });

  console.log(`[DOWNLOAD] Done. ${downloaded.length} clips saved to downloaded-clips.json`);
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
