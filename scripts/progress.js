'use strict';
// progress.js — pipeline step banners + total elapsed time
// CLI: node scripts/progress.js <projectDir> <stepNum|"summary"> [description...]
// API: const { step, summary } = require('./progress');

const fs   = require('fs');
const path = require('path');

const TOTAL = 15;

function readState(projectDir) {
  const p = path.join(projectDir, 'state.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}

function writeState(projectDir, state) {
  fs.writeFileSync(path.join(projectDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

function fmt(ms) {
  const totalSecs = Math.round(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return mins > 0 ? `${mins}хв ${secs}сек` : `${secs}сек`;
}

const LINE = '━'.repeat(54);

function step(projectDir, n, desc) {
  const state = readState(projectDir);
  if (n === 1 && !state.pipelineStartedAt) {
    state.pipelineStartedAt = new Date().toISOString();
    writeState(projectDir, state);
  }
  console.log(`\n${LINE}`);
  console.log(`  ${n}/${TOTAL}  ${desc}`);
  console.log(LINE);
}

function summary(projectDir) {
  const state = readState(projectDir);
  if (!state.pipelineStartedAt) return;
  const elapsed = Date.now() - new Date(state.pipelineStartedAt).getTime();
  console.log(`\n${LINE}`);
  console.log(`  Загальний час пайплайну: ${fmt(elapsed)}`);
  console.log(`${LINE}\n`);
}

module.exports = { step, summary };

if (require.main === module) {
  const [,, projectDir, n, ...rest] = process.argv;
  if (!projectDir || !n) {
    console.error('Usage: node progress.js <projectDir> <stepNum|summary> [description]');
    process.exit(1);
  }
  if (n === 'summary') summary(projectDir);
  else step(projectDir, parseInt(n), rest.join(' '));
}
