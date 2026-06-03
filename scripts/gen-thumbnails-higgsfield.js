'use strict';
// Usage: node scripts/gen-thumbnails-higgsfield.js <runId>
// Generates thumbnail-v2.png (emotion-enhanced) and thumbnail-v3.png (composite scene)
// via Higgsfield img2img, using thumbnails from editorial.json.
// Requires Higgsfield MCP to be available in the calling Claude session.
// This script is invoked BY Claude (not standalone) — it exports helper functions
// and the prompt builders that Claude uses when calling Higgsfield MCP tools.

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node gen-thumbnails-higgsfield.js <runId>'); process.exit(1); }

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

const mainThumb = thumbnails.find(t => t.main) || thumbnails[0];
const secondaryThumbs = thumbnails.filter(t => !t.main);

// ── frame extraction ──────────────────────────────────────────────────────────

function extractFrame(clipId, atSec, outPath) {
  const cleanMp4 = path.join(projectDir, 'processed', clipId, 'clean.mp4');
  if (!fs.existsSync(cleanMp4)) {
    throw new Error(`clean.mp4 not found for clip ${clipId}: ${cleanMp4}`);
  }
  execSync(
    `ffmpeg -ss ${atSec} -i "${cleanMp4}" -frames:v 1 -q:v 2 -y "${outPath}"`,
    { stdio: 'pipe' }
  );
  console.log(`[frame] extracted ${path.basename(outPath)} from ${clipId} at ${atSec}s`);
}

// ── prompt builders ───────────────────────────────────────────────────────────

function buildV2Prompt(clip) {
  const emotions = {
    funny:     'amplify the uncontrollable laughter — face scrunched with joy, tears of amusement',
    cringe:    'amplify the cringe — exaggerated grimace, eyes squinting, visible discomfort',
    fail:      'amplify the shock and disbelief — jaw dropped, eyes impossibly wide, frozen in horror',
    hype:      'amplify the triumph and intensity — electric energy, fist clenched, eyes blazing',
    surprise:  'amplify the pure shock — frozen mid-gasp, eyes wide, hand raised to face',
    emotional: 'amplify the raw vulnerability — intense gaze, overwhelming genuine emotion',
    other:     'amplify the dominant expression — more intense and readable at thumbnail size',
  };
  const emotionLine = emotions[clip.emotionalCategory] || emotions.other;
  return `Ultra-high-quality YouTube thumbnail. Enhance this frame: ${emotionLine}. ` +
    `Cinematic rim lighting — strong edge glow on face contour, deep volumetric shadows. ` +
    `Hyperreal saturated colors, HDR high-contrast look. ` +
    `Sharpen eyes and face details. ` +
    `Remove all stream overlays, chat, UI elements, watermarks, alerts. ` +
    `Keep person fully recognizable — same face, same moment, amplified. ` +
    `Photorealistic, no artifacts. MrBeast thumbnail aesthetic. 1280x720.`;
}

function buildV3Prompt(mainClip, secondaryClips) {
  const emotions = {
    funny:     'laughing uncontrollably',
    cringe:    'cringing in disbelief',
    fail:      'shocked and horrified',
    hype:      'pumped with excitement',
    surprise:  'frozen in pure shock',
    emotional: 'overwhelmed with emotion',
    other:     'showing strong expression',
  };
  const mainEmotion = emotions[mainClip.emotionalCategory] || 'showing strong expression';
  const secondaryDesc = secondaryClips
    .map(c => `${c.streamer} (${emotions[c.emotionalCategory] || 'reacting'})`)
    .join(', ');
  return `Ultra-high-quality YouTube thumbnail with multiple Twitch streamers. ` +
    `Main subject ${mainClip.streamer} large in foreground — ${mainEmotion}, dramatically amplified expression. ` +
    (secondaryDesc ? `Secondary subjects ${secondaryDesc} smaller in background, all hyperbolized — wide eyes, strong emotions, high energy. ` : '') +
    `Unified cinematic rim lighting across all subjects from one dramatic source. ` +
    `Consistent hyperreal color grading — warm vivid skin tones, deep cinematic background connecting everyone. ` +
    `Subjects feel naturally in the same world, seamlessly composited — not a collage. ` +
    `HDR contrast. All faces sharp, depth of field in background. ` +
    `Remove all overlays, chat, UI. Photorealistic, no artifacts. ` +
    `MrBeast group shot composition. 1280x720.`;
}

// ── Higgsfield params (passed by Claude when calling generate_image MCP) ──────
const HIGGSFIELD_MODEL = 'nano_banana_pro';
const HIGGSFIELD_RESOLUTION = '2k';
const HIGGSFIELD_ASPECT_RATIO = '16:9';

// ── scored-clips lookup ───────────────────────────────────────────────────────

const scoredPath = path.join(projectDir, 'clips', 'scored-clips.json');
const scoredClips = fs.existsSync(scoredPath) ? JSON.parse(fs.readFileSync(scoredPath, 'utf8')) : [];
function getClipMeta(clipId) {
  return scoredClips.find(c => c.id === clipId) || {};
}

// ── main ──────────────────────────────────────────────────────────────────────

const mainMeta = getClipMeta(mainThumb.clipId);
const secondaryMetas = secondaryThumbs.map(t => ({ ...getClipMeta(t.clipId), ...t }));

// Extract frames
const mainFramePath = path.join(exportsDir, 'thumb-frame-main.png');
extractFrame(mainThumb.clipId, mainThumb.at, mainFramePath);

const secondaryFramePaths = secondaryThumbs.map((t, i) => {
  const p = path.join(exportsDir, `thumb-frame-secondary-${i}.png`);
  extractFrame(t.clipId, t.at, p);
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
  v3: thumbnails.length >= 2 ? {
    outPath: path.join(exportsDir, 'thumbnail-v3.png'),
    prompt: buildV3Prompt({ ...mainMeta, streamer: mainMeta.broadcaster_name || 'streamer' },
      secondaryMetas.map(m => ({ ...m, streamer: m.broadcaster_name || 'streamer' }))),
  } : null,
};

console.log(JSON.stringify(output, null, 2));
