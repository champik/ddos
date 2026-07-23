'use strict';
// state.js — спільна робота з JSON/state.json: BOM-safe читання, атомарний запис.
// Атомарність: запис у tmp-файл + rename, щоб краш посеред запису не лишав битий state.json.

const fs = require('fs');
const path = require('path');

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function readJson(p) {
  return JSON.parse(stripBom(fs.readFileSync(p, 'utf8')));
}

function readJsonSafe(p, fallback = null) {
  try { return readJson(p); } catch { return fallback; }
}

function writeJsonAtomic(p, data) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function statePath(projectDir) {
  return path.join(projectDir, 'state.json');
}

function readState(projectDir) {
  return readJsonSafe(statePath(projectDir), {});
}

// Read-modify-write одним викликом, щоб мінімізувати вікно втрати оновлень.
function updateState(projectDir, fn) {
  const p = statePath(projectDir);
  if (!fs.existsSync(p)) return null;
  const state = readJsonSafe(p, {});
  fn(state);
  writeJsonAtomic(p, state);
  return state;
}

// Статуси стадій: 'done' | 'done_with_errors' | 'failed' | 'running' | 'pending'
// done_with_errors = частина елементів оброблена; failed = результату немає.
function setStage(projectDir, stage, status) {
  return updateState(projectDir, s => {
    s.stages = s.stages || {};
    s.stages[stage] = status;
  });
}

// Підсумковий статус стадії за лічильниками.
function stageStatus(okCount, failCount) {
  if (failCount === 0) return 'done';
  if (okCount === 0) return 'failed';
  return 'done_with_errors';
}

module.exports = {
  stripBom, readJson, readJsonSafe, writeJsonAtomic,
  readState, updateState, setStage, stageStatus,
};
