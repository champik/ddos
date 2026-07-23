'use strict';
// analytics-ledger.js — реєстр залитих на YouTube відео (analytics/videos-index.json).
// Пишеться youtube-upload.js у момент заливки; читається pull-analytics.js,
// щоб мапити videoId → runId/clipId/стрімер/гра для агрегацій по стрімерах.

const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('./state');

const ANALYTICS_DIR = 'analytics';
const INDEX_PATH = path.join(ANALYTICS_DIR, 'videos-index.json');

function readIndex() {
  return readJsonSafe(INDEX_PATH, []);
}

// Додає/оновлює запис по videoId (idempotent — повторна заливка оновлює той самий запис)
function appendEntry(entry) {
  fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
  const index = readIndex();
  const i = index.findIndex(e => e.videoId === entry.videoId);
  if (i >= 0) index[i] = { ...index[i], ...entry };
  else index.push(entry);
  writeJsonAtomic(INDEX_PATH, index);
}

module.exports = { readIndex, appendEntry, INDEX_PATH, ANALYTICS_DIR };
