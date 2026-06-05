#!/usr/bin/env node
// YouTube Data API v3 upload tool
// Commands:
//   node youtube-upload.js upload-video  <runId> <metadata.json> <video.mp4> <thumbnail.png>
//   node youtube-upload.js upload-short  <runId> <clipId> <short.mp4> <mainVideoId> [publishAt ISO]
//   node youtube-upload.js publish-video <videoId>
//   node youtube-upload.js publish-all   <runId> [publishNowISO]
//     publishNowISO — коли опублікувати основне відео (default: зараз)
//     Шортси: +1год, +2год, +3год... від publishNowISO
'use strict';
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SECRET_PATH = process.env.YOUTUBE_CLIENT_SECRET_PATH || 'auth/client_secret.json';
const TOKEN_PATH  = 'auth/token.json';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube'
];

async function getAuth() {
  if (!fs.existsSync(SECRET_PATH)) {
    throw new Error(`client_secret.json not found at ${SECRET_PATH}. Download from Google Cloud Console.`);
  }
  const creds = JSON.parse(fs.readFileSync(SECRET_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oauth2 = new OAuth2Client(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const saved = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2.setCredentials(saved);
    try {
      const { credentials } = await oauth2.refreshAccessToken();
      oauth2.setCredentials(credentials);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials), 'utf8');
      return oauth2;
    } catch {
      console.log('Refresh token expired, re-authorizing...');
      fs.unlinkSync(TOKEN_PATH);
    }
  }

  const url = oauth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('\n=== YouTube Authorization ===');
  console.log('Open in browser:\n' + url);
  console.log('\nPaste the authorization code:');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise(r => rl.question('> ', a => { rl.close(); r(a.trim()); }));
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  fs.mkdirSync('auth', { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens), 'utf8');
  console.log('Token saved to auth/token.json');
  return oauth2;
}

async function uploadVideo(runId, metadataPath, videoPath, thumbnailPath) {
  const auth = await getAuth();
  const yt = google.youtube({ version: 'v3', auth });
  const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const size = fs.statSync(videoPath).size;

  console.log(`Uploading ${path.basename(videoPath)} (${(size/1e6).toFixed(0)}MB)...`);

  const res = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: meta.selectedTitle || meta.title || (meta.titleOptions && meta.titleOptions.specificityStakes) || 'Daily Dose Of Stream',
        description: meta.description || '',
        tags: meta.tags || ['twitch', 'gaming', 'clips'],
        categoryId: '20',
        defaultLanguage: 'en'
      },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false }
    },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(videoPath) }
  }, {
    onUploadProgress: e => {
      const pct = Math.round(e.bytesRead / size * 100);
      process.stdout.write(`\rProgress: ${pct}%`);
    }
  });

  const videoId = res.data.id;
  process.stdout.write('\n');
  console.log(`Uploaded (private): https://youtu.be/${videoId}`);

  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    const thumbMime = thumbnailPath.endsWith('.jpg') || thumbnailPath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    await yt.thumbnails.set({ videoId, media: { mimeType: thumbMime, body: fs.createReadStream(thumbnailPath) } });
    console.log('Thumbnail set.');
  }

  const statePath = path.join('projects', runId, 'state.json');
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.outputs = state.outputs || {};
    state.outputs.youtubeVideoId = videoId;
    state.stages.publish = 'done';
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  return videoId;
}

function buildShortDescription(clipMeta) {
  const descHashtags = (clipMeta && clipMeta.descriptionHashtags)
    ? clipMeta.descriptionHashtags.join(' ')
    : '#twitch #stream #live';
  const body = clipMeta && clipMeta.description;
  return body ? `${body}\n\n${descHashtags}` : descHashtags;
}

// publishAt — optional ISO string. If provided, video is scheduled (private until that time).
async function uploadShort(runId, clipId, shortPath, mainVideoId, hookText, publishAt) {
  const auth = await getAuth();
  const yt = google.youtube({ version: 'v3', auth });

  // Try to get proper title + metadata from metadata.json
  const metaPath = path.join('projects', runId, 'exports', 'metadata.json');
  let clipMeta = null;
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    clipMeta = (meta.shortsMetadata || []).find(m => m.clipId === clipId) || null;
  }

  const title = clipMeta
    ? clipMeta.title.slice(0, 100)
    : `${hookText || 'Clip'} | Daily Dose Of Stream #shorts`.slice(0, 100);

  const description = buildShortDescription(clipMeta);

  const statusBody = publishAt
    ? { privacyStatus: 'private', publishAt, selfDeclaredMadeForKids: false }
    : { privacyStatus: 'public', selfDeclaredMadeForKids: false };

  const tags = clipMeta
    ? (clipMeta.tags || []).map(h => h.replace(/^#/, ''))
    : ['DailyDoseOfStream', 'TwitchClips', 'Shorts'];

  const size = fs.statSync(shortPath).size;
  if (publishAt) {
    console.log(`Uploading short (scheduled ${publishAt}): ${path.basename(shortPath)} — ${title}`);
  } else {
    console.log(`Uploading short (public now): ${path.basename(shortPath)} — ${title}`);
  }

  const res = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
        tags,
        categoryId: '20',
        defaultLanguage: 'en'
      },
      status: statusBody
    },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(shortPath) }
  }, {
    onUploadProgress: e => {
      const pct = Math.round(e.bytesRead / size * 100);
      process.stdout.write(`\rProgress: ${pct}%`);
    }
  });

  const shortId = res.data.id;
  process.stdout.write('\n');
  if (publishAt) {
    console.log(`Scheduled: https://youtube.com/shorts/${shortId} at ${publishAt}`);
  } else {
    console.log(`Short live: https://youtube.com/shorts/${shortId}`);
  }

  const statePath = path.join('projects', runId, 'state.json');
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.outputs = state.outputs || {};
    state.outputs.youtubeShortsIds = state.outputs.youtubeShortsIds || [];
    state.outputs.youtubeShortsIds.push({ clipId, shortId, publishAt: publishAt || 'now' });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  return shortId;
}

async function publishVideo(videoId) {
  const auth = await getAuth();
  const yt = google.youtube({ version: 'v3', auth });
  await yt.videos.update({
    part: ['status'],
    requestBody: { id: videoId, status: { privacyStatus: 'public' } }
  });
  console.log(`Published: https://youtu.be/${videoId}`);
}

// publish-all: publish main video now + schedule shorts at +Xhr, +2Xhr, ...
// publishNowISO — optional, when to make main video public (default: now)
// selectedTitle — optional, overrides metadata.json title
// shortIntervalMinutes — optional, minutes between shorts (default: 60)
// selectedThumbnail — optional, 'v1'/'v2'/'v3', saved to metadata for review display
async function publishAll(runId, publishNowISO, selectedTitle, shortIntervalMinutes, selectedThumbnail) {
  const intervalMs = (parseFloat(shortIntervalMinutes) || 60) * 60 * 1000;
  const statePath = path.join('projects', runId, 'state.json');
  if (!fs.existsSync(statePath)) throw new Error(`state.json not found for runId: ${runId}`);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  const mainVideoId = state.outputs && state.outputs.youtubeVideoId;
  if (!mainVideoId) throw new Error('Main video not uploaded yet. Run upload-video first.');

  // 0. Update title if provided
  if (selectedTitle) {
    const auth = await getAuth();
    const yt = google.youtube({ version: 'v3', auth });
    const metaPath = path.join('projects', runId, 'exports', 'metadata.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const currentSnippet = (await yt.videos.list({ part: ['snippet'], id: [mainVideoId] })).data.items[0]?.snippet;
    if (currentSnippet) {
      await yt.videos.update({
        part: ['snippet'],
        requestBody: {
          id: mainVideoId,
          snippet: { ...currentSnippet, title: selectedTitle.slice(0, 100), categoryId: currentSnippet.categoryId || '22' }
        }
      });
      meta.selectedTitle = selectedTitle;
      if (selectedThumbnail) meta.selectedThumbnail = selectedThumbnail;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      console.log(`Title updated: "${selectedTitle}"`);
    }
  }

  // 1. Publish main video
  const mainPublishTime = (publishNowISO && publishNowISO.trim()) ? new Date(publishNowISO) : new Date();
  // If scheduled in the future, use publishAt; otherwise publish now
  if (mainPublishTime > new Date(Date.now() + 60000)) {
    const auth = await getAuth();
    const yt = google.youtube({ version: 'v3', auth });
    await yt.videos.update({
      part: ['status'],
      requestBody: {
        id: mainVideoId,
        status: { privacyStatus: 'private', publishAt: mainPublishTime.toISOString() }
      }
    });
    console.log(`Main video scheduled: https://youtu.be/${mainVideoId} at ${mainPublishTime.toISOString()}`);
  } else {
    await publishVideo(mainVideoId);
    console.log(`Main video published now: https://youtu.be/${mainVideoId}`);
  }

  state.publishedAt = mainPublishTime.toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  // 2. Schedule shorts at +1hr, +2hr, ...
  const plan = JSON.parse(fs.readFileSync(path.join('projects', runId, 'edit', 'episode-plan.json'), 'utf8'));
  const shortClipIds = plan.shortClipIds || [];
  const shortsDir = path.join('projects', runId, 'exports', 'shorts');

  let scheduled = 0;
  for (let i = 0; i < shortClipIds.length; i++) {
    const clipId = shortClipIds[i];
    const shortPath = path.join(shortsDir, `${clipId}.mp4`);
    if (!fs.existsSync(shortPath)) {
      console.log(`[SKIP] Short not found: ${clipId}`);
      continue;
    }
    const shortPublishTime = new Date(mainPublishTime.getTime() + (i + 1) * intervalMs);
    // YouTube requires publishAt to be at least 5 minutes in the future
    const minTime = new Date(Date.now() + 5 * 60 * 1000);
    const actualPublishTime = shortPublishTime < minTime ? minTime : shortPublishTime;

    await uploadShort(runId, clipId, shortPath, mainVideoId, null, actualPublishTime.toISOString());
    scheduled++;
  }

  console.log(`\n✅ Done. Main video published + ${scheduled} shorts scheduled.`);
  console.log(`   Main:   https://youtu.be/${mainVideoId}`);
  console.log(`   Shorts: published every 1hr starting ${new Date(mainPublishTime.getTime() + 3600000).toLocaleTimeString()}`);

  // Re-read state to avoid overwriting youtubeShortsIds written by uploadShort
  const finalState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  finalState.stages.publish = 'done';
  finalState.status = 'published';
  fs.writeFileSync(statePath, JSON.stringify(finalState, null, 2));

  // Cleanup large intermediate files
  const { execFileSync } = require('child_process');
  try {
    console.log('\n[cleanup] Removing intermediate files...');
    execFileSync(process.execPath, ['scripts/cleanup-episode.js', runId], { stdio: 'inherit' });
  } catch (e) {
    console.warn('[cleanup] Warning:', e.message);
  }
}

const [,, cmd, ...args] = process.argv;
const cmds = {
  'upload-video':  () => uploadVideo(...args),
  'upload-short':  () => uploadShort(...args),
  'publish-video': () => publishVideo(args[0]),
  'publish-all':   () => publishAll(args[0], args[1], args[2], args[3], args[4])
};
if (!cmds[cmd]) { console.error('Unknown command:', cmd, '\nValid: upload-video, upload-short, publish-video, publish-all'); process.exit(1); }
cmds[cmd]().catch(e => { console.error('Error:', e.message); process.exit(1); });
