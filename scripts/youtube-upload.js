#!/usr/bin/env node
// YouTube Data API v3 upload tool
// Commands:
//   node youtube-upload.js upload-video <runId> <metadata.json> <video.mp4> <thumbnail.png>
//   node youtube-upload.js upload-short <runId> <clipId> <short.mp4> <mainVideoId> <hookText>
//   node youtube-upload.js publish-video <videoId>
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

  // First-time OAuth flow
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
        title: (meta.titleOptions && meta.titleOptions[0]) || meta.title || 'Daily Dose Of Stream',
        description: meta.description || '',
        tags: meta.hashtags || ['twitch', 'gaming', 'clips'],
        categoryId: '20',
        defaultLanguage: 'uk'
      },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false }
    },
    media: { body: fs.createReadStream(videoPath) }
  }, {
    onUploadProgress: e => {
      const pct = Math.round(e.bytesRead / size * 100);
      process.stdout.write(`\rProgress: ${pct}%`);
    }
  });

  const videoId = res.data.id;
  process.stdout.write('\n');
  console.log(`Uploaded (unlisted): https://youtu.be/${videoId}`);

  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    await yt.thumbnails.set({ videoId, media: { body: fs.createReadStream(thumbnailPath) } });
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

async function uploadShort(runId, clipId, shortPath, mainVideoId, hookText) {
  const auth = await getAuth();
  const yt = google.youtube({ version: 'v3', auth });
  const title = `${hookText || 'Clip'} #shorts`.slice(0, 100);
  const desc  = mainVideoId
    ? `Full episode → https://youtu.be/${mainVideoId}\n\n#shorts #twitch #gaming`
    : '#shorts #twitch #gaming';

  const res = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description: desc, tags: ['shorts','twitch','gaming'], categoryId: '20' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    },
    media: { body: fs.createReadStream(shortPath) }
  });
  const shortId = res.data.id;
  console.log(`Short: https://youtube.com/shorts/${shortId}`);

  const statePath = path.join('projects', runId, 'state.json');
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.outputs = state.outputs || {};
    state.outputs.youtubeShortsIds = state.outputs.youtubeShortsIds || [];
    state.outputs.youtubeShortsIds.push(shortId);
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

const [,, cmd, ...args] = process.argv;
const cmds = {
  'upload-video':  () => uploadVideo(...args),
  'upload-short':  () => uploadShort(...args),
  'publish-video': () => publishVideo(args[0])
};
if (!cmds[cmd]) { console.error('Unknown command:', cmd); process.exit(1); }
cmds[cmd]().catch(e => { console.error('Error:', e.message); process.exit(1); });
