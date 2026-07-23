#!/usr/bin/env node
// DDOS Pipeline — TRANSCRIBE batch runner
// Usage: node scripts/transcribe-batch.js <runId>

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawn }                       = require('child_process');
const { readJson, updateState, stageStatus } = require('./lib/state');
const { pythonBin }                   = require('./lib/sys');
const { getProjectDir }               = require('./lib/project-path');

const [,, runId] = process.argv;
const RUN_DIR = getProjectDir(runId);

require('./progress').step(RUN_DIR, 7, 'Транскрипція (WhisperX + Demucs)');

const editorial = readJson(path.join(RUN_DIR, 'edit', 'editorial.json'));
const clipOrder = (editorial.clipOrder || []).filter(id => !String(id).startsWith('__recon'));
console.log(`[TRANSCRIBE] ${clipOrder.length} edited clips`);

const dlPath = path.join(RUN_DIR, 'clips', 'downloaded-clips.json');
const downloaded = fs.existsSync(dlPath) ? readJson(dlPath) : [];
const broadcasterMap = {};
downloaded.forEach(c => { broadcasterMap[c.id] = c.broadcaster_name || c.broadcaster_login || c.id; });

// Build jobs list — skip already-done transcripts
const jobs = [];
let preSkipped = 0;
for (const clipId of clipOrder) {
  const videoPath      = path.join(RUN_DIR, 'processed', clipId, 'clean.mp4');
  const transcriptPath = path.join(RUN_DIR, 'processed', clipId, 'transcript.json');

  if (!fs.existsSync(videoPath)) {
    console.log(`[SKIP] ${clipId}: clean.mp4 not found`);
    preSkipped++;
    continue;
  }

  if (fs.existsSync(transcriptPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
      if (!existing.error) { preSkipped++; continue; }
    } catch {}
  }

  jobs.push({ video_path: videoPath, output_path: transcriptPath, clip_id: clipId });
}

console.log(`[TRANSCRIBE] ${jobs.length} to process, ${preSkipped} already cached`);

if (jobs.length === 0) {
  console.log('[TRANSCRIBE] Nothing to do');
  updateState(RUN_DIR, s => { s.stages = s.stages || {}; s.stages.transcribe = 'done'; });
  process.exit(0);
}

// Write jobs to temp file
const jobsFile = path.join(os.tmpdir(), `ddos-transcribe-${Date.now()}.json`);
fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

async function main() {
  return new Promise((resolve) => {
    const proc = spawn(pythonBin(), ['scripts/transcribe-batch.py', jobsFile], {
      cwd: path.join(__dirname, '..'),
    });

    let errors = 0;
    let done   = 0;

    const onLine = (line) => {
      process.stdout.write(line + '\n');
      if (line.includes('] OK '))   done++;
      if (line.includes('] ERR '))  errors++;
    };

    let buf = '';
    const pump = (chunk) => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop();
      parts.forEach(onLine);
    };

    proc.stdout.on('data', pump);
    proc.stderr.on('data', pump);

    proc.on('close', (code) => {
      if (buf.trim()) onLine(buf.trim());
      try { fs.unlinkSync(jobsFile); } catch {}

      if (code !== 0) errors++;
      console.log(`\n[TRANSCRIBE] Done: ${done} transcribed, ${preSkipped} cached, ${errors} errors`);

      updateState(RUN_DIR, s => {
        s.stages = s.stages || {};
        s.stages.transcribe = stageStatus(done + preSkipped, errors);
      });
      resolve();
    });

    proc.on('error', (e) => {
      console.error(`[FATAL] ${e.message}`);
      try { fs.unlinkSync(jobsFile); } catch {}
      updateState(RUN_DIR, s => { s.stages = s.stages || {}; s.stages.transcribe = 'failed'; });
      resolve();
    });
  });
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
