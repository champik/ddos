'use strict';
// Usage: node scripts/gen-thumbnails-higgsfield.js <runId>
// Extracts frames from all editorial.thumbnails clips and outputs Higgsfield job params.
// Claude calls generate_image MCP with these params (nano_banana_pro + seedream_v4_5 per image).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { getProjectDir } = require('./lib/project-path');

const runId = process.argv[2];
if (!runId) {
  console.error('Usage: node gen-thumbnails-higgsfield.js <runId>');
  process.exit(1);
}

const projectDir = getProjectDir(runId);
const editorialPath = path.join(projectDir, 'edit', 'editorial.json');
const exportsDir = path.join(projectDir, 'exports');

if (!fs.existsSync(editorialPath)) {
  console.error('editorial.json not found:', editorialPath);
  process.exit(1);
}

const editorial = JSON.parse(fs.readFileSync(editorialPath, 'utf8'));
const thumbnails = editorial.thumbnails || [];

const downloadedPath = path.join(projectDir, 'clips', 'downloaded-clips.json');
const downloaded = fs.existsSync(downloadedPath)
  ? JSON.parse(fs.readFileSync(downloadedPath, 'utf8').replace(/^﻿/, ''))
  : [];
const localPaths = Object.fromEntries(downloaded.map(c => [c.id, c.localPath]));

const { buildBasenameMap, processedTypeDir } = require('./lib/clip-naming');
const basenames = buildBasenameMap(editorial.clipOrder, downloaded);
const CLEAN_DIR = processedTypeDir(projectDir, 'clean');

const scoredPath = path.join(projectDir, 'clips', 'scored-clips.json');
const scoredClips = fs.existsSync(scoredPath)
  ? JSON.parse(fs.readFileSync(scoredPath, 'utf8'))
  : [];
function getClipMeta(clipId) {
  return scoredClips.find(c => c.id === clipId) || {};
}

const metadataPath = path.join(projectDir, 'exports', 'metadata.json');
const metadata = fs.existsSync(metadataPath)
  ? JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  : {};
const thumbnailHooksMap = Object.fromEntries(
  (metadata.thumbnailHooks || []).map(h => [h.clipId, h.hook])
);

if (thumbnails.length === 0) {
  console.error('No thumbnails defined in editorial.json');
  process.exit(1);
}

function getDuration(filePath) {
  const result = execFileSync('ffprobe', [
    '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath,
  ], { encoding: 'utf8', stdio: 'pipe' }).trim();
  return parseFloat(result) || null;
}

function getVideoDimensions(filePath) {
  const result = execFileSync('ffprobe', [
    '-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath,
  ], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const [w, h] = result.split(',').map(Number);
  return { w: w || 1920, h: h || 1080 };
}

function extractFrame(clipId, atSec, outPath, crop) {
  const basename = basenames[clipId];
  const srcMp4 = localPaths[clipId] || (basename && path.join(CLEAN_DIR, `${basename}.mp4`));
  if (!fs.existsSync(srcMp4)) {
    throw new Error(`source video not found for clip ${clipId}: ${srcMp4}`);
  }
  // A seek landing exactly on (or past) the last frame yields no output frame at
  // all — ffmpeg still exits 0, so the missing file goes unnoticed unless checked.
  // Marks made by scrubbing to the very end of a clip in edit.html hit this.
  const duration = getDuration(srcMp4);
  if (duration && atSec >= duration) atSec = Math.max(0, duration - 0.1);
  const vfArgs = [];
  if (crop && crop.w < 99) {
    const { w: vw, h: vh } = getVideoDimensions(srcMp4);
    const cx = Math.round((crop.x / 100) * vw);
    const cy = Math.round((crop.y / 100) * vh);
    const cw = Math.round((crop.w / 100) * vw);
    const ch = Math.round((crop.h / 100) * vh);
    vfArgs.push('-vf', `crop=${cw}:${ch}:${cx}:${cy},scale=1920:1080`);
  }
  execFileSync('ffmpeg', [
    '-ss', String(atSec), '-i', srcMp4,
    '-frames:v', '1', '-q:v', '2', ...vfArgs, '-update', '1', '-y', outPath,
  ], { stdio: 'pipe' });
  if (!fs.existsSync(outPath)) {
    throw new Error(`ffmpeg exited 0 but wrote no frame for ${clipId} at ${atSec}s (source duration issue?)`);
  }
  console.log(`[frame] extracted ${path.basename(outPath)} from ${clipId} at ${atSec}s${crop && crop.w < 99 ? ' (cropped)' : ''}`);
}

fs.mkdirSync(exportsDir, { recursive: true });

const items = thumbnails.map((t, i) => {
  const meta = getClipMeta(t.clipId);
  const framePath = path.join(exportsDir, `thumb-frame-${i}.png`);
  extractFrame(t.clipId, t.at, framePath, t.crop);
  return {
    index: i,
    clipId: t.clipId,
    isMain: !!t.main,
    broadcasterName: meta.broadcaster_name || t.clipId,
    gameName: meta.game_name || '',
    // t.hook — user-entered in edit.html when marking the frame. Falls back to the old
    // metadata.json-driven map for episodes edited before this field existed.
    hook: t.hook || thumbnailHooksMap[t.clipId] || '',
    framePath,
    nanoCandidatePath: path.join(exportsDir, `thumb-candidate-${i}-nano.png`),
    seedreamCandidatePath: path.join(exportsDir, `thumb-candidate-${i}-seedream.png`),
  };
});

console.log(JSON.stringify({
  items,
  HIGGSFIELD_NANO_RESOLUTION: '2k',
  HIGGSFIELD_SEEDREAM_QUALITY: 'high',
  HIGGSFIELD_ASPECT_RATIO: '16:9',
}, null, 2));
