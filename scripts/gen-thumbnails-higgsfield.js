'use strict';
// Usage: node scripts/gen-thumbnails-higgsfield.js <runId>
// Extracts frames from all editorial.thumbnails clips and outputs Higgsfield job params.
// Claude calls generate_image MCP with these params (nano_banana_pro + seedream_v4_5 per image).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const runId = process.argv[2];
if (!runId) {
  console.error('Usage: node gen-thumbnails-higgsfield.js <runId>');
  process.exit(1);
}

const projectDir = path.join('projects', runId);
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

const scoredPath = path.join(projectDir, 'clips', 'scored-clips.json');
const scoredClips = fs.existsSync(scoredPath)
  ? JSON.parse(fs.readFileSync(scoredPath, 'utf8'))
  : [];
function getClipMeta(clipId) {
  return scoredClips.find(c => c.id === clipId) || {};
}

if (thumbnails.length === 0) {
  console.error('No thumbnails defined in editorial.json');
  process.exit(1);
}

function getVideoDimensions(filePath) {
  const result = execSync(
    `ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`,
    { encoding: 'utf8', stdio: 'pipe' },
  ).trim();
  const [w, h] = result.split(',').map(Number);
  return { w: w || 1920, h: h || 1080 };
}

function extractFrame(clipId, atSec, outPath, crop) {
  const srcMp4 = localPaths[clipId] || path.join(projectDir, 'processed', clipId, 'clean.mp4');
  if (!fs.existsSync(srcMp4)) {
    throw new Error(`source video not found for clip ${clipId}: ${srcMp4}`);
  }
  let vf = '';
  if (crop && crop.w < 99) {
    const { w: vw, h: vh } = getVideoDimensions(srcMp4);
    const cx = Math.round((crop.x / 100) * vw);
    const cy = Math.round((crop.y / 100) * vh);
    const cw = Math.round((crop.w / 100) * vw);
    const ch = Math.round((crop.h / 100) * vh);
    vf = `-vf "crop=${cw}:${ch}:${cx}:${cy},scale=1920:1080"`;
  }
  execSync(
    `ffmpeg -ss ${atSec} -i "${srcMp4}" -frames:v 1 -q:v 2 ${vf} -update 1 -y "${outPath}"`,
    { stdio: 'pipe' },
  );
  console.log(`[frame] extracted ${path.basename(outPath)} from ${clipId} at ${atSec}s${crop && crop.w < 99 ? ' (cropped)' : ''}`);
}

function buildPrompt() {
  return (
    `Transform <<<image_1>>> into a hyperbolized YouTube thumbnail reaction. ` +
    `Take the exact expression the person already has and push it to the extreme. ` +
    `If their mouth is open — make it more dramatically open. ` +
    `If their mouth is closed — keep it closed, but make eyes wider, brows higher, expression more intense. ` +
    `Never add an open mouth that does not exist in <<<image_1>>>. ` +
    `Never add people or characters that are not in <<<image_1>>> — only the person(s) already present. ` +
    `YouTube thumbnail aesthetic: extreme contrast, vivid saturated colors, ` +
    `sharp face detail, cinematic lighting boost. ` +
    `Remove all stream overlays, chat, UI, watermarks. ` +
    `Photorealistic, no artifacts.`
  );
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
    framePath,
    prompt: buildPrompt(),
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
