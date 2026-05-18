'use strict';
// download-only.js — download clips from prescore-candidates.json
// Usage: node scripts/download-only.js <projectFolder>

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const projectFolder = process.argv[2];
if (!projectFolder) { console.error('Usage: node download-only.js <projectFolder>'); process.exit(1); }

const PROJECT_DIR = path.join('projects', projectFolder);
const CLIPS_DIR = path.join(PROJECT_DIR, 'clips');
const DOWNLOADS_DIR = path.join(PROJECT_DIR, 'downloads');

fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const candidates = JSON.parse(fs.readFileSync(path.join(CLIPS_DIR, 'prescore-candidates.json'), 'utf8'));

function buildFilename(clip) {
  const cat = (clip.game_name || 'unknown').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const streamer = (clip.broadcaster_name || 'unknown').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const views = clip.view_count;
  const date = (clip.created_at || '').slice(0, 10).replace(/-/g, '_');
  return `${cat}_${streamer}_${views}_${date}.mp4`;
}

function downloadClip(clip) {
  return new Promise((resolve) => {
    const filename = buildFilename(clip);
    const outPath = path.join(DOWNLOADS_DIR, filename);

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10000) {
      resolve({ clip, filename, success: true, skipped: true });
      return;
    }

    const url = clip.url;
    const outPathEscaped = outPath.replace(/\\/g, '/');
    const cmd = `python -m yt_dlp --no-playlist --format "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 --output "${outPathEscaped}" --quiet "${url}"`;

    exec(cmd, { timeout: 180000 }, (err) => {
      if (err || !fs.existsSync(outPath) || fs.statSync(outPath).size < 10000) {
        resolve({ clip, filename, success: false, error: err?.message?.slice(0, 120) });
      } else {
        resolve({ clip, filename, success: true });
      }
    });
  });
}

function updateState(updates) {
  const statePath = path.join(PROJECT_DIR, 'state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  if (updates.stages) { state.stages = state.stages || {}; Object.assign(state.stages, updates.stages); }
  if (updates.counts) { state.counts = state.counts || {}; Object.assign(state.counts, updates.counts); }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

async function main() {
  console.log(`\n[DOWNLOAD] Завантажую ${candidates.length} кліпів...`);

  const downloaded = [];
  const failed = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(downloadClip));

    for (const r of results) {
      if (r.success) {
        const localPath = `projects/${projectFolder}/downloads/${r.filename}`;
        downloaded.push({ ...r.clip, localPath });
        const mark = r.skipped ? '↩' : '✓';
        console.log(`  ${mark} [${downloaded.length + failed.length}/${candidates.length}] ${r.clip.broadcaster_name} — ${r.clip.game_name}`);
      } else {
        failed.push(r.clip);
        console.log(`  ✗ [${downloaded.length + failed.length}/${candidates.length}] FAIL: ${r.clip.broadcaster_name} — ${r.error?.slice(0, 80)}`);
      }
    }
  }

  console.log(`\n  Downloaded: ${downloaded.length} | Failed: ${failed.length}`);
  fs.writeFileSync(path.join(CLIPS_DIR, 'downloaded-clips.json'), JSON.stringify(downloaded, null, 2));
  updateState({ stages: { download: 'done' }, counts: { downloaded: downloaded.length } });
  console.log('✓ Download complete');
}

main().catch(e => { console.error('Download failed:', e.message); process.exit(1); });
