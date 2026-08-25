#!/usr/bin/env node
// DDOS Harry Potter meme-trailer — TRAILER_PREP
// Downloads the source trailer and transcribes it. Scene segmentation
// (trailer/scenes.json — character/line/timestamp per beat) is a judgment
// call made by Claude in conversation afterward, not by this script.
//
// Usage: node scripts/trailer-prep.js <runId> <youtubeUrl>
//
// Writes: <projectDir>/trailer/source.mp4
//         <projectDir>/trailer/transcript.json  (transcribe-batch.py output shape)

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tryDownload, isValidMp4 } = require('./lib/download');
const { getProjectDir } = require('./lib/project-path');
const { pythonBin } = require('./lib/sys');

const [,, runId, youtubeUrl] = process.argv;
if (!runId || !youtubeUrl) {
  console.error('Usage: node scripts/trailer-prep.js <runId> <youtubeUrl>');
  process.exit(1);
}

const PROJECT_DIR = getProjectDir(runId);
const TRAILER_DIR = path.join(PROJECT_DIR, 'trailer');
const SOURCE_PATH = path.join(TRAILER_DIR, 'source.mp4');
const TRANSCRIPT_PATH = path.join(TRAILER_DIR, 'transcript.json');
const TMP_DIR = path.join('tmp', 'harry-trailer');

async function downloadTrailer() {
  fs.mkdirSync(TRAILER_DIR, { recursive: true });

  if (fs.existsSync(SOURCE_PATH) && await isValidMp4(SOURCE_PATH)) {
    console.log('[TRAILER-PREP] source.mp4 already exists and is valid — skipping download');
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, 1500 * attempt));
    console.log(`[TRAILER-PREP] downloading (attempt ${attempt})...`);
    const result = await tryDownload(youtubeUrl, SOURCE_PATH);
    if (result.ok) return;
    console.warn(`[TRAILER-PREP] attempt ${attempt} failed: ${result.stderr}`);
  }
  throw new Error('Failed to download trailer after 3 attempts');
}

function runTranscribeBatch(jobsFile) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin(), ['scripts/transcribe-batch.py', jobsFile], {
      cwd: path.join(__dirname, '..'),
    });
    let buf = '';
    const pump = chunk => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop();
      parts.forEach(line => process.stdout.write('  ' + line + '\n'));
    };
    proc.stdout.on('data', pump);
    proc.stderr.on('data', pump);
    proc.on('close', code => {
      if (buf.trim()) process.stdout.write('  ' + buf.trim() + '\n');
      code === 0 ? resolve() : reject(new Error(`transcribe-batch.py exited ${code}`));
    });
    proc.on('error', reject);
  });
}

async function transcribeTrailer() {
  if (fs.existsSync(TRANSCRIPT_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(TRANSCRIPT_PATH, 'utf8'));
      if (!existing.error) {
        console.log('[TRAILER-PREP] transcript.json already exists — skipping transcription');
        return;
      }
    } catch {}
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const jobsFile = path.join(TMP_DIR, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify([
    { video_path: SOURCE_PATH, output_path: TRANSCRIPT_PATH, clip_id: 'trailer' },
  ], null, 2));

  console.log('[TRAILER-PREP] transcribing...');
  await runTranscribeBatch(jobsFile);
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  const result = JSON.parse(fs.readFileSync(TRANSCRIPT_PATH, 'utf8'));
  if (result.error) throw new Error(`Transcription failed: ${result.error}`);
  console.log(`[TRAILER-PREP] transcribed: ${result.words.length} words, ${result.duration}s`);
}

async function main() {
  await downloadTrailer();
  await transcribeTrailer();
  console.log('[TRAILER-PREP] done — next: Claude segments trailer/transcript.json into trailer/scenes.json');
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
