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

// stage2.js runs APPLY_EDITORIAL→VOD_REPLACE→{TRANSCRIBE, OVERLAYS+BUILD_CONCAT+
// RENDER_LONG, EXTRACT_FRAMES} as separate node processes, several of which call
// updateState() on the SAME state.json. Without a lock, two processes finishing
// near-simultaneously can lost-update each other's read-modify-write — the
// second writer overwrites the first's just-written stage key with its own
// stale copy of the rest of the file. A stale lock (crashed process) is stolen
// after LOCK_TIMEOUT_MS rather than deadlocking forever.
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 25;

function acquireLock(lockPath) {
  const start = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx'));
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch {}
}

// Read-modify-write одним викликом, щоб мінімізувати вікно втрати оновлень.
function updateState(projectDir, fn) {
  const p = statePath(projectDir);
  if (!fs.existsSync(p)) return null;
  const lockPath = p + '.lock';
  acquireLock(lockPath);
  try {
    const state = readJsonSafe(p, {});
    fn(state);
    writeJsonAtomic(p, state);
    return state;
  } finally {
    releaseLock(lockPath);
  }
}

// Статуси стадій: 'done' | 'done_with_errors' | 'failed' | 'running' | 'pending'
// done_with_errors = частина елементів оброблена; failed = результату немає.
// Підсумковий статус стадії за лічильниками.
function stageStatus(okCount, failCount) {
  if (failCount === 0) return 'done';
  if (okCount === 0) return 'failed';
  return 'done_with_errors';
}

module.exports = {
  stripBom, readJson, readJsonSafe, writeJsonAtomic,
  readState, updateState, stageStatus,
};
