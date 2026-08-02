'use strict';
// clip-naming.js — shared basename scheme for CapCut-facing processed/ output.
//
// Basename = "<NN>_<streamer>_<idSuffix>" (e.g. "01_xqc_a7k2m9qx"), where NN is
// the clip's 1-based position in clipOrder. NN gives CapCut-friendly ordering;
// idSuffix (same convention as downloads/ filenames, see lib/download.js) is
// the stable link back to clipId for per-clip caching — NN alone already
// guarantees filename uniqueness, so a reorder in edit.html only requires
// renaming files (idSuffix keeps them matchable to their clipId), never
// re-encoding.
//
// processed/ groups output by type instead of by clipId:
//   processed/clean/<basename>.mp4 (+ .edit-hash.txt, .precensor.mp4)
//   processed/transcripts/<basename>.json
//   processed/censor/<basename>.censor-log.json (+ .censor-hash.txt)
//   processed/overlayed/<basename>.mp4   ← final CapCut handoff folder

const path = require('path');

function sanitizeStreamer(name) {
  return (name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function idSuffix(clipId) {
  return String(clipId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(-8) || 'noid';
}

function buildClipBasename(order, streamerName, clipId) {
  const nn = String(order).padStart(2, '0');
  return `${nn}_${sanitizeStreamer(streamerName)}_${idSuffix(clipId)}`;
}

// clipOrder: editorial.clipOrder or plan.clipOrder (both mirror each other).
// downloaded: downloaded-clips.json array (source of broadcaster_name).
function buildBasenameMap(clipOrder, downloaded) {
  const byId = Object.fromEntries((downloaded || []).map(c => [c.id, c]));
  const filtered = (clipOrder || []).filter(id => !String(id).startsWith('__recon'));
  const map = {};
  filtered.forEach((clipId, i) => {
    const c = byId[clipId];
    const streamer = c ? (c.broadcaster_name || c.broadcaster_login) : clipId;
    map[clipId] = buildClipBasename(i + 1, streamer, clipId);
  });
  return map;
}

function processedTypeDir(projectDir, type) {
  return path.join(projectDir, 'processed', type);
}

module.exports = { buildClipBasename, buildBasenameMap, processedTypeDir, sanitizeStreamer, idSuffix };
