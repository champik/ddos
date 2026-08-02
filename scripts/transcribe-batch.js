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

const { buildBasenameMap, processedTypeDir } = require('./lib/clip-naming');
const basenames = buildBasenameMap(editorial.clipOrder, downloaded);
const CLEAN_DIR = processedTypeDir(RUN_DIR, 'clean');
const TRANSCRIPTS_DIR = processedTypeDir(RUN_DIR, 'transcripts');
fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

// Build jobs list — skip already-done transcripts. A missing clean.mp4 is a
// separate case from a cached skip: it means APPLY_EDITORIAL failed for that
// clip upstream, and must count as an error, not a silent "done" transcribe.
const jobs = [];
let cachedSkipped = 0;
const missingClips = [];
for (const clipId of clipOrder) {
  const basename = basenames[clipId];
  if (!basename) continue;
  const videoPath      = path.join(CLEAN_DIR, `${basename}.mp4`);
  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${basename}.json`);

  if (!fs.existsSync(videoPath)) {
    console.warn(`[MISSING] ${clipId}: clean.mp4 not found — APPLY_EDITORIAL likely failed for this clip`);
    missingClips.push(clipId);
    continue;
  }

  if (fs.existsSync(transcriptPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
      if (!existing.error) { cachedSkipped++; continue; }
    } catch {}
  }

  jobs.push({ video_path: videoPath, output_path: transcriptPath, clip_id: clipId });
}

console.log(`[TRANSCRIBE] ${jobs.length} to process, ${cachedSkipped} already cached, ${missingClips.length} missing clean.mp4`);

function recordMissing(s) {
  if (missingClips.length === 0) return;
  s.warnings = s.warnings || [];
  s.warnings.push(...missingClips.map(id => `transcribe: clean.mp4 missing for ${id} (APPLY_EDITORIAL failed)`));
}

if (jobs.length === 0) {
  console.log('[TRANSCRIBE] Nothing to do');
  updateState(RUN_DIR, s => {
    s.stages = s.stages || {};
    s.stages.transcribe = stageStatus(cachedSkipped, missingClips.length);
    recordMissing(s);
  });
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
      console.log(`\n[TRANSCRIBE] Done: ${done} transcribed, ${cachedSkipped} cached, ${errors} errors, ${missingClips.length} missing clean.mp4`);

      updateState(RUN_DIR, s => {
        s.stages = s.stages || {};
        s.stages.transcribe = stageStatus(done + cachedSkipped, errors + missingClips.length);
        recordMissing(s);
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
