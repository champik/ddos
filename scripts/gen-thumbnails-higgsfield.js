'use strict';
// Usage: node scripts/gen-thumbnails-higgsfield.js <runId>
// Generates thumbnail-v2.png (emotion-enhanced) and thumbnail-v3.png (composite scene)
// via Higgsfield img2img, using thumbnails from editorial.json.
// Requires Higgsfield MCP to be available in the calling Claude session.
// This script is invoked BY Claude (not standalone) — it exports helper functions
// and the prompt builders that Claude uses when calling Higgsfield MCP tools.

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

if (thumbnails.length === 0) {
  console.error('No thumbnails defined in editorial.json');
  process.exit(1);
}

const mainThumb = thumbnails.find((t) => t.main) || thumbnails[0];
const secondaryThumbs = thumbnails.filter((t) => !t.main);

// ── frame extraction ──────────────────────────────────────────────────────────

function extractFrame(clipId, atSec, outPath, crop) {
  const cleanMp4 = path.join(projectDir, 'processed', clipId, 'clean.mp4');
  if (!fs.existsSync(cleanMp4)) {
    throw new Error(`clean.mp4 not found for clip ${clipId}: ${cleanMp4}`);
  }
  let vf = '';
  if (crop && crop.w < 99) {
    const cx = Math.round((crop.x / 100) * 1920);
    const cy = Math.round((crop.y / 100) * 1080);
    const cw = Math.round((crop.w / 100) * 1920);
    const ch = Math.round((crop.h / 100) * 1080);
    vf = `-vf "crop=${cw}:${ch}:${cx}:${cy},scale=1920:1080"`;
  }
  execSync(
    `ffmpeg -ss ${atSec} -i "${cleanMp4}" -frames:v 1 -q:v 2 ${vf} -update 1 -y "${outPath}"`,
    {
      stdio: 'pipe',
    },
  );
  console.log(
    `[frame] extracted ${path.basename(outPath)} from ${clipId} at ${atSec}s${crop && crop.w < 99 ? ' (cropped)' : ''}`,
  );
}

// ── prompt builders ───────────────────────────────────────────────────────────

function buildV2Prompt(clip) {
  const emotions = {
    funny:
      'amplify the uncontrollable laughter on the person in @image_1 — face scrunched with joy, tears of amusement',
    cringe:
      'amplify the cringe on the person in @image_1 — exaggerated grimace, eyes squinting, visible discomfort',
    fail: 'amplify the shock and disbelief on the person in @image_1 — jaw dropped, eyes impossibly wide, frozen in horror',
    hype: 'amplify the triumph and intensity on the person in @image_1 — electric energy, fist clenched, eyes blazing',
    surprise:
      'amplify the pure shock on the person in @image_1 — frozen mid-gasp, eyes wide, hand raised to face',
    emotional:
      'amplify the raw vulnerability on the person in @image_1 — intense gaze, overwhelming genuine emotion',
    other:
      'dramatically exaggerate the facial expression of the person in @image_1 — wide open eyes, mouth open in shock or amusement, hyper-expressive face as if reacting to something unbelievable',
  };
  const emotionLine = emotions[clip.emotionalCategory] || emotions.other;
  return (
    `Ultra-high-quality YouTube thumbnail. ${emotionLine}. ` +
    `Keep original scene lighting — do not add artificial rim lights, glows, or dramatic shadows on the face. ` +
    `Hyperreal saturated colors, HDR high-contrast look. ` +
    `Sharpen eyes and face details. ` +
    `Remove all stream overlays, chat, UI elements, watermarks, alerts. ` +
    `Keep the person in @image_1 fully recognizable — same face, same body position, amplified expression only. ` +
    `Photorealistic, no artifacts. `
  );
}

function buildV3Prompt(mainClip, secondaryClips) {
  const emotions = {
    funny: 'laughing uncontrollably',
    cringe: 'cringing in disbelief',
    fail: 'shocked and horrified',
    hype: 'pumped with excitement',
    surprise: 'frozen in pure shock',
    emotional: 'overwhelmed with emotion',
    other: 'showing strong expression',
  };
  const mainEmotion = emotions[mainClip.emotionalCategory] || 'showing strong expression';
  const secondaryDesc = secondaryClips
    .map((c, i) => `person from @image_${i + 2} (${emotions[c.emotionalCategory] || 'reacting'})`)
    .join(', ');
  return (
    `Ultra-high-quality YouTube thumbnail with multiple people. ` +
    `Person from @image_1 large in foreground — ${mainEmotion}, dramatically amplified expression. ` +
    (secondaryDesc
      ? `${secondaryDesc} smaller in background, all hyperbolized — wide eyes, strong emotions, high energy. `
      : '') +
    `Keep original scene lighting for each person — do not add artificial rim lights, glows, or dramatic shadows. ` +
    `Consistent hyperreal color grading — warm vivid skin tones, deep cinematic background connecting everyone. ` +
    `Subjects feel naturally in the same world, seamlessly composited — not a collage. ` +
    `HDR contrast. All faces sharp, depth of field in background. ` +
    `Remove all overlays, chat, UI. Photorealistic, no artifacts. `
  );
}

// ── Higgsfield params (passed by Claude when calling generate_image MCP) ──────
const HIGGSFIELD_MODEL = 'seedream_v4_5';
const HIGGSFIELD_RESOLUTION = '4k';
const HIGGSFIELD_ASPECT_RATIO = '16:9';

// ── scored-clips lookup ───────────────────────────────────────────────────────

const scoredPath = path.join(projectDir, 'clips', 'scored-clips.json');
const scoredClips = fs.existsSync(scoredPath)
  ? JSON.parse(fs.readFileSync(scoredPath, 'utf8'))
  : [];
function getClipMeta(clipId) {
  return scoredClips.find((c) => c.id === clipId) || {};
}

// ── main ──────────────────────────────────────────────────────────────────────

const mainMeta = getClipMeta(mainThumb.clipId);
const secondaryMetas = secondaryThumbs.map((t) => ({ ...getClipMeta(t.clipId), ...t }));

// Extract frames
const mainFramePath = path.join(exportsDir, 'thumb-frame-main.png');
extractFrame(mainThumb.clipId, mainThumb.at, mainFramePath, mainThumb.crop);

const secondaryFramePaths = secondaryThumbs.map((t, i) => {
  const p = path.join(exportsDir, `thumb-frame-secondary-${i}.png`);
  extractFrame(t.clipId, t.at, p, t.crop);
  return p;
});

// Output prompts and frame paths for Claude to use with Higgsfield MCP
const output = {
  mainFrame: mainFramePath,
  secondaryFrames: secondaryFramePaths,
  v2: {
    outPath: path.join(exportsDir, 'thumbnail-v2.png'),
    prompt: buildV2Prompt(mainMeta),
  },
  v3:
    thumbnails.length >= 2
      ? {
          outPath: path.join(exportsDir, 'thumbnail-v3.png'),
          prompt: buildV3Prompt(
            { ...mainMeta, streamer: mainMeta.broadcaster_name || 'streamer' },
            secondaryMetas.map((m) => ({ ...m, streamer: m.broadcaster_name || 'streamer' })),
          ),
        }
      : null,
};

console.log(JSON.stringify(output, null, 2));
