#!/usr/bin/env node
// DDOS Pipeline — TRANSCRIBE batch runner
// Usage: node scripts/transcribe-batch.js <runId>

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const [,, runId] = process.argv;
const RUN_DIR = path.join('projects', runId);
const CLIPS_DIR = path.join(RUN_DIR, 'clips');

const editorial = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'edit', 'editorial.json'), 'utf8'));
const clipOrder = editorial.clipOrder || [];
console.log(`[TRANSCRIBE] ${clipOrder.length} edited clips to transcribe`);

let done = 0;
let skipped = 0;
let errors = 0;

async function transcribeClip(clipId) {
  const videoPath = path.join(RUN_DIR, 'processed', clipId, 'clean.mp4');
  const processedDir = path.join(RUN_DIR, 'processed', clipId);
  const transcriptPath = path.join(processedDir, 'transcript.json');

  if (!fs.existsSync(videoPath)) {
    console.error(`\n[SKIP] ${clipId}: clean.mp4 not found`);
    skipped++;
    return;
  }

  if (fs.existsSync(transcriptPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
      if (!existing.error) { skipped++; return; }
    } catch {}
  }

  return new Promise((resolve) => {
    const proc = spawn('python3', ['scripts/transcribe.py', videoPath, transcriptPath, clipId]);
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => out += d.toString());
    proc.on('close', code => {
      done++;
      if (code !== 0) {
        errors++;
        fs.writeFileSync(transcriptPath, JSON.stringify({ clip_id: clipId, error: 'exit_code_' + code, text: '', words: [] }, null, 2));
      }
      process.stdout.write(`\r  ${done + skipped}/${clipOrder.length} done  (errors: ${errors})   `);
      resolve();
    });
    proc.on('error', e => {
      errors++;
      fs.writeFileSync(transcriptPath, JSON.stringify({ clip_id: clipId, error: e.message, text: '', words: [] }, null, 2));
      done++;
      resolve();
    });
  });
}

async function main() {
  // Sequential — GPU can only run one model at a time
  for (const clipId of clipOrder) {
    await transcribeClip(clipId);
  }
  console.log(`\n[TRANSCRIBE] Done: ${done} transcribed, ${skipped} skipped, ${errors} errors`);

  const state = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'state.json'), 'utf8').replace(/^﻿/, ''));
  state.stages.transcribe = 'done';
  fs.writeFileSync(path.join(RUN_DIR, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
