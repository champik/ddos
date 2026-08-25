'use strict';
// download.js — спільна yt-dlp логіка для download-clips.js і gaming-screen.js.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pythonBin } = require('./sys');

function buildFilename(clip) {
  const cat = (clip.game_name || clip._category || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const streamer = (clip.broadcaster_name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  const views = clip.view_count;
  const date = (clip.created_at || '').slice(0, 10).replace(/-/g, '_');
  // Суфікс із clip.id гарантує унікальність: два кліпи одного стрімера
  // з однаковими views за день інакше отримали б один файл.
  const idSuffix = String(clip.id || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(-8) || 'noid';
  return `${cat}_${streamer}_${views}_${date}_${idSuffix}.mp4`;
}

function isValidMp4(filePath) {
  return new Promise(resolve => {
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', filePath]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => out += d);
    proc.on('close', code => resolve(code === 0 && !out.includes('moov atom') && !out.includes('Invalid data')));
    proc.on('error', () => resolve(false));
  });
}

function tryDownload(url, outPath) {
  return new Promise(resolve => {
    const proc = spawn(pythonBin(), ['-m', 'yt_dlp',
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
    proc.on('close', code => resolve({ ok: code === 0, stderr: stderr.slice(0, 200) }));
    proc.on('error', e => resolve({ ok: false, stderr: e.message }));
  });
}

async function downloadClip(clip, outDir, maxAttempts = 3) {
  const filename = buildFilename(clip);
  const outPath = path.join(outDir, filename);

  if (fs.existsSync(outPath)) {
    const valid = await isValidMp4(outPath);
    if (valid) return { clip, filename, status: 'skipped' };
    fs.unlinkSync(outPath);
    console.log(`\n  [REDOWNLOAD] corrupted: ${filename}`);
  }

  let lastErr = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, 1500 * attempt));
    const result = await tryDownload(clip.url, outPath);
    if (result.ok) return { clip, filename, status: 'ok' };
    lastErr = result.stderr;
  }
  return { clip, filename, status: 'error', error: lastErr };
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

module.exports = { buildFilename, isValidMp4, downloadClip, runParallel, tryDownload };
