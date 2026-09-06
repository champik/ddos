'use strict';
// resolve-manifest.js — pure builder for the assemble manifest consumed by
// scripts/resolve_ctl.py. Keeps all DDOS naming/ordering/duration knowledge in
// Node; resolve_ctl.py only executes mechanical Resolve API calls from this
// data — it doesn't know what a "basename" or "clipOrder" is.

const path = require('path');
const { buildBasenameMap } = require('./clip-naming');

const OVERLAY_START_OFFSET_S = 1;   // overlay appears 1s into each clip
const OVERLAY_MAX_DURATION_S = 5;   // fixed 5s window, clamped to clip length
const OVERLAY_TRANSFORM = { zoomX: 0.25, zoomY: 0.25, pan: -1800, tilt: -400 };

// editorial: parsed editorial.json ({ clipOrder, ... })
// downloaded: parsed downloaded-clips.json (array)
// clipDurations: { [clipId]: durationSeconds } — real ffprobe'd duration of
//   processed/clean/<basename>.mp4. Passed in (not probed here) so this stays
//   a pure, filesystem-free function.
// projectDir: absolute path to the project directory
// introPath / outroPath: absolute paths to the fixed intro/outro assets
function buildAssembleManifest({ runId, editorial, downloaded, clipDurations, projectDir, introPath, outroPath }) {
  const clipIds = (editorial.clipOrder || []).filter(id => !String(id).startsWith('__recon'));
  const basenames = buildBasenameMap(editorial.clipOrder, downloaded);
  const dlById = Object.fromEntries((downloaded || []).map(c => [c.id, c]));

  const clips = clipIds.map(clipId => {
    const basename = basenames[clipId];
    const duration = clipDurations[clipId];
    if (duration == null) {
      throw new Error(`buildAssembleManifest: missing duration for clip ${clipId} (${basename})`);
    }
    const overlayDuration = Math.max(0, Math.min(OVERLAY_MAX_DURATION_S, duration - OVERLAY_START_OFFSET_S));
    const clip = dlById[clipId];
    return {
      clipId,
      basename,
      duration,
      clipPath: path.join(projectDir, 'processed', 'clean', `${basename}.mp4`),
      overlayPath: path.join(projectDir, 'processed', 'streamers_name', `${basename}.png`),
      overlayStartOffset: OVERLAY_START_OFFSET_S,
      overlayDuration,
      streamer: clip ? (clip.broadcaster_name || clip.broadcaster_login) : clipId,
    };
  });

  return {
    runId,
    resolveProjectName: runId,
    timelineName: 'Episode',
    introPath,
    outroPath,
    clips,
    overlayTransform: OVERLAY_TRANSFORM,
  };
}

module.exports = { buildAssembleManifest, OVERLAY_START_OFFSET_S, OVERLAY_MAX_DURATION_S, OVERLAY_TRANSFORM };
