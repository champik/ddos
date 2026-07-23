'use strict';
// Instagram Graph API publishing via Cloudflare R2 for public media URLs.
// Commands:
//   node publish-instagram.js publish-all <runId> <publishAtISO>
//     publishAtISO — ISO 8601, when main video goes live on YouTube (shorts stagger +1h, +2h, ...)
//   node publish-instagram.js publish-post  <runId> <publishAtISO>
//   node publish-instagram.js publish-reels <runId> <publishAtISO>

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const https = require('https');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { readJson, readJsonSafe, updateState } = require('./lib/state');
const { getProjectDir } = require('./lib/project-path');

// ── R2 client ─────────────────────────────────────────────────────────────────

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_S3_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET     = process.env.R2_BUCKET;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

async function r2Upload(localPath, key) {
  const body     = fs.readFileSync(localPath);
  const mimeType = localPath.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg';
  await r2.send(new PutObjectCommand({
    Bucket:      R2_BUCKET,
    Key:         key,
    Body:        body,
    ContentType: mimeType,
  }));
  return `${R2_PUBLIC_URL}/${key}`;
}

async function r2Delete(key) {
  await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

// ── Meta Graph API helper ─────────────────────────────────────────────────────

const IG_ID    = process.env.INSTAGRAM_ACCOUNT_ID;
const IG_TOKEN = process.env.INSTAGRAM_USER_TOKEN;
const GRAPH    = 'graph.facebook.com';

function graphPost(endpoint, params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ ...params, access_token: IG_TOKEN }).toString();
    const options = { hostname: GRAPH, path: `/v21.0${endpoint}?${qs}`, method: 'POST' };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (json.error) reject(new Error(`Meta API error: ${json.error.message} (code ${json.error.code})`));
        else resolve(json);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function graphGet(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ ...params, access_token: IG_TOKEN }).toString();
    const options = { hostname: GRAPH, path: `/v21.0${endpoint}?${qs}`, method: 'GET' };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (json.error) reject(new Error(`Meta API error: ${json.error.message} (code ${json.error.code})`));
        else resolve(json);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Poll until container status = FINISHED (Meta processes the media async).
async function waitForContainer(containerId, maxWaitMs = 300_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await graphGet(`/${containerId}`, { fields: 'status_code,status' });
    if (res.status_code === 'FINISHED') return;
    if (res.status_code === 'ERROR') throw new Error(`Container ${containerId} failed: ${res.status}`);
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`Container ${containerId} timed out after ${maxWaitMs / 1000}s`);
}

// ── Publish helpers ───────────────────────────────────────────────────────────

// scheduledPublishTime must be a Unix timestamp (seconds), 10 min–75 days from now.
function toUnixTs(isoString) {
  return Math.floor(new Date(isoString).getTime() / 1000);
}

async function publishFeedPost(runId, thumbnailPath, caption, publishAtISO) {
  const r2Key   = `ep/${runId}/thumbnail.jpg`;
  const imageUrl = await r2Upload(thumbnailPath, r2Key);
  console.log(`[R2] Uploaded thumbnail → ${imageUrl}`);

  const unixTs = toUnixTs(publishAtISO);
  const container = await graphPost(`/${IG_ID}/media`, {
    image_url:              imageUrl,
    caption,
    scheduled_publish_time: unixTs,
    is_carousel_item:       false,
  });
  console.log(`[IG] Feed container created: ${container.id}`);
  await waitForContainer(container.id);

  const pub = await graphPost(`/${IG_ID}/media_publish`, {
    creation_id:            container.id,
    scheduled_publish_time: unixTs,
  });
  console.log(`[IG] Feed post scheduled: ${pub.id} at ${publishAtISO}`);
  await r2Delete(r2Key);
  console.log(`[R2] Deleted ${r2Key}`);
  return pub.id;
}

async function publishReel(runId, clipId, shortPath, caption, publishAtISO) {
  const r2Key   = `ep/${runId}/short-${clipId}.mp4`;
  const videoUrl = await r2Upload(shortPath, r2Key);
  console.log(`[R2] Uploaded reel ${clipId} → ${videoUrl}`);

  const unixTs = toUnixTs(publishAtISO);
  const container = await graphPost(`/${IG_ID}/media`, {
    media_type:             'REELS',
    video_url:              videoUrl,
    caption,
    scheduled_publish_time: unixTs,
    share_to_feed:          true,
  });
  console.log(`[IG] Reel container created: ${container.id} (${clipId})`);
  await waitForContainer(container.id, 600_000); // video processing can take longer

  const pub = await graphPost(`/${IG_ID}/media_publish`, {
    creation_id:            container.id,
    scheduled_publish_time: unixTs,
  });
  console.log(`[IG] Reel scheduled: ${pub.id} at ${publishAtISO}`);
  await r2Delete(r2Key);
  console.log(`[R2] Deleted ${r2Key}`);
  return pub.id;
}

// ── Caption builders ──────────────────────────────────────────────────────────

function buildFeedCaption(meta) {
  const title = meta.selectedTitle || (Array.isArray(meta.titleOptions) && meta.titleOptions[0]) || 'Daily Dose Of Stream';
  const hashtags = '#TwitchClips #Twitch #StreamHighlights #JustChatting #Gaming';
  return `${title}\n\n${hashtags}`;
}

function buildReelCaption(clipMeta) {
  if (!clipMeta) return '#TwitchClips #Twitch #Shorts';
  const body = clipMeta.description || '';
  const tags  = (clipMeta.hashtags || []).join(' ');
  return body ? `${body}\n\n${tags}` : tags;
}

// ── Main commands ─────────────────────────────────────────────────────────────

async function publishPost(runId, publishAtISO) {
  const projectDir    = getProjectDir(runId);
  const thumbnailPath = path.join(projectDir, 'exports', 'thumbnail.png');
  if (!fs.existsSync(thumbnailPath)) throw new Error(`Thumbnail not found: ${thumbnailPath}`);

  const meta    = readJson(path.join(projectDir, 'exports', 'metadata.json'));
  const caption = buildFeedCaption(meta);

  const postId = await publishFeedPost(runId, thumbnailPath, caption, publishAtISO);
  updateState(projectDir, s => {
    s.outputs = s.outputs || {};
    s.outputs.instagramPostId = postId;
  });
  console.log(`\n✅ Instagram feed post scheduled: ${postId}`);
}

async function publishReels(runId, publishAtISO, intervalMinutes = 120) {
  const projectDir = getProjectDir(runId);
  const meta       = readJson(path.join(projectDir, 'exports', 'metadata.json'));
  const plan       = readJson(path.join(projectDir, 'edit', 'episode-plan.json'));
  const shortIds   = plan.shortClipIds || [];
  const shortsDir  = path.join(projectDir, 'exports', 'shorts');

  const state          = readJsonSafe(path.join(projectDir, 'state.json'), {});
  const alreadyPosted  = new Set(
    (state.outputs?.instagramReelsIds || []).map(r => r.clipId)
  );

  const intervalMs = intervalMinutes * 60 * 1000;
  const baseTime   = new Date(publishAtISO).getTime();
  let slot         = 0;

  for (const clipId of shortIds) {
    if (alreadyPosted.has(clipId)) {
      console.log(`[SKIP] Already posted reel: ${clipId}`);
      slot++;
      continue;
    }
    const shortPath = path.join(shortsDir, `${clipId}.mp4`);
    if (!fs.existsSync(shortPath)) {
      console.log(`[SKIP] Short not found: ${clipId}`);
      continue;
    }
    const clipMeta   = (meta.shortsMetadata || []).find(m => m.clipId === clipId) || null;
    const caption    = buildReelCaption(clipMeta);
    const publishAt  = new Date(baseTime + (slot + 1) * intervalMs).toISOString();

    const reelId = await publishReel(runId, clipId, shortPath, caption, publishAt);
    alreadyPosted.add(clipId);
    slot++;

    updateState(projectDir, s => {
      s.outputs = s.outputs || {};
      s.outputs.instagramReelsIds = s.outputs.instagramReelsIds || [];
      s.outputs.instagramReelsIds.push({ clipId, reelId, publishAt });
    });
  }

  console.log(`\n✅ ${slot} Instagram reels scheduled.`);
}

async function publishAll(runId, publishAtISO, intervalMinutes) {
  console.log(`\n=== Instagram publish-all: ${runId} at ${publishAtISO} ===\n`);

  await publishPost(runId, publishAtISO);
  await publishReels(runId, publishAtISO, parseFloat(intervalMinutes) || 120);

  const projectDir = getProjectDir(runId);
  updateState(projectDir, s => { s.stages.instagram = 'done'; });

  console.log('\n📸 Story: post manually from the phone — use exports/thumbnail.png or a clip preview.');
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv;
const cmds = {
  'publish-all':   () => publishAll(args[0], args[1], args[2]),
  'publish-post':  () => publishPost(args[0], args[1]),
  'publish-reels': () => publishReels(args[0], args[1], args[2]),
};
if (!cmds[cmd]) {
  console.error('Unknown command:', cmd, '\nValid: publish-all, publish-post, publish-reels');
  process.exit(1);
}
cmds[cmd]().catch(e => { console.error('Error:', e.message); process.exit(1); });
