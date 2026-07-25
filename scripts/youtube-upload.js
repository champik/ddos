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
const fs = require('fs');
const path = require('path');
const { readJson, readJsonSafe, writeJsonAtomic, updateState } = require('./lib/state');
const { getProjectDir } = require('./lib/project-path');
const { NON_GAMING_IDS } = require('./lib/categories');
const { getAuth } = require('./lib/yt-auth');

async function uploadVideo(runId, metadataPath, videoPath, thumbnailPath) {
  const auth = await getAuth();
  const yt = google.youtube({ version: 'v3', auth });
  const meta = readJson(metadataPath);
  const size = fs.statSync(videoPath).size;

  console.log(`Uploading ${path.basename(videoPath)} (${(size/1e6).toFixed(0)}MB)...`);

  const res = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: (meta.selectedTitle || (Array.isArray(meta.titleOptions) && meta.titleOptions[0]) || 'Daily Dose Of Stream').slice(0, 100),
        description: meta.description || '',
        tags: meta.tags || ['twitch', 'gaming', 'clips'],
        categoryId: '24', // Entertainment
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
    let finalThumbPath = thumbnailPath;
    const thumbSizeMB = fs.statSync(thumbnailPath).size / 1e6;
    if (thumbSizeMB > 1.9 || thumbnailPath.endsWith('.png')) {
      const { spawnSync } = require('child_process');
      const compressedPath = thumbnailPath.replace(/\.[^.]+$/, '-yt.jpg');
      spawnSync('ffmpeg', ['-i', thumbnailPath, '-vf', 'scale=1920:1080', '-q:v', '3', '-update', '1', '-y', compressedPath], { stdio: 'pipe' });
      if (fs.existsSync(compressedPath)) {
        finalThumbPath = compressedPath;
        console.log(`Thumbnail compressed: ${(fs.statSync(compressedPath).size / 1e6).toFixed(2)}MB`);
      }
    }
    const thumbMime = finalThumbPath.endsWith('.jpg') || finalThumbPath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    await yt.thumbnails.set({ videoId, media: { mimeType: thumbMime, body: fs.createReadStream(finalThumbPath) } });
    console.log('Thumbnail set.');
  }

  updateState(getProjectDir(runId), s => {
    s.outputs = s.outputs || {};
    s.outputs.youtubeVideoId = videoId;
    s.stages.publish = 'done';
  });

  return videoId;
}

function buildShortDescription(clipMeta) {
  const descHashtags = (clipMeta && clipMeta.hashtags)
    ? clipMeta.hashtags.join(' ')
    : '#twitch #stream #live';
  const body = clipMeta && clipMeta.description;
  return body ? `${body}\n\n${descHashtags}` : descHashtags;
}

// publishAt — optional ISO string. If provided, video is scheduled (private until that time).
async function uploadShort(runId, clipId, shortPath, mainVideoId, hookText, publishAt) {
  const auth = await getAuth();
  const yt = google.youtube({ version: 'v3', auth });

  // Try to get proper title + metadata from metadata.json
  const metaPath = path.join(getProjectDir(runId), 'exports', 'metadata.json');
  let clipMeta = null;
  if (fs.existsSync(metaPath)) {
    const meta = readJson(metaPath);
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
    ? (clipMeta.hashtags || []).map(h => h.replace(/^#/, ''))
    : ['DailyDoseOfStream', 'TwitchClips', 'Shorts'];

  // Determine category: Gaming (20) for gaming clips, Entertainment (24) for JC/IRL/Music/etc
  const dlPath = path.join(getProjectDir(runId), 'clips', 'downloaded-clips.json');
  let shortCategoryId = '24';
  let dlClip = null;
  if (fs.existsSync(dlPath)) {
    dlClip = readJson(dlPath).find(c => c.id === clipId) || null;
    if (dlClip && dlClip.game_id && !NON_GAMING_IDS.has(String(dlClip.game_id))) shortCategoryId = '20';
  }

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
        categoryId: shortCategoryId,
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

  updateState(getProjectDir(runId), s => {
    s.outputs = s.outputs || {};
    s.outputs.youtubeShortsIds = s.outputs.youtubeShortsIds || [];
    s.outputs.youtubeShortsIds.push({ clipId, shortId, publishAt: publishAt || 'now' });
  });

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
// shortIntervalMinutes — optional, minutes between shorts (default: 120; caller
// typically tightens this when there are many shorts to fit into a day)
// selectedThumbnail — optional, 'v1'/'v2'/'v3', saved to metadata for review display
async function publishAll(runId, publishNowISO, selectedTitle, shortIntervalMinutes, selectedThumbnail) {
  const intervalMs = (parseFloat(shortIntervalMinutes) || 120) * 60 * 1000;
  const projectDir = getProjectDir(runId);
  const statePath = path.join(projectDir, 'state.json');
  if (!fs.existsSync(statePath)) throw new Error(`state.json not found for runId: ${runId}`);
  const state = readJson(statePath);

  const mainVideoId = state.outputs && state.outputs.youtubeVideoId;
  if (!mainVideoId) throw new Error('Main video not uploaded yet. Run upload-video first.');

  // 0. Update title if provided
  if (selectedTitle) {
    const auth = await getAuth();
    const yt = google.youtube({ version: 'v3', auth });
    const metaPath = path.join(projectDir, 'exports', 'metadata.json');
    const meta = readJson(metaPath);
    const currentSnippet = (await yt.videos.list({ part: ['snippet'], id: [mainVideoId] })).data.items[0]?.snippet;
    if (currentSnippet) {
      await yt.videos.update({
        part: ['snippet'],
        requestBody: {
          id: mainVideoId,
          snippet: { ...currentSnippet, title: selectedTitle.slice(0, 100), categoryId: currentSnippet.categoryId || '24' }
        }
      });
      meta.selectedTitle = selectedTitle;
      if (selectedThumbnail) meta.selectedThumbnail = selectedThumbnail;
      writeJsonAtomic(metaPath, meta);
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

  updateState(projectDir, s => { s.publishedAt = mainPublishTime.toISOString(); });

  // 2. Schedule shorts at +1hr, +2hr, ...
  const plan = readJson(path.join(projectDir, 'edit', 'episode-plan.json'));
  // Order must match editorial.json's `shorts` array (= review.html grid order),
  // NOT clipOrder/shortClipIds — those follow episode timeline appearance, which
  // can differ from the order the editor actually arranged for posting.
  const shortClipIds = (plan.shorts && plan.shorts.length > 0)
    ? plan.shorts.map(item => item.type === 'solo' ? item.clipId : item.clips[0])
    : (plan.shortClipIds || []);
  const shortsDir = path.join(projectDir, 'exports', 'shorts');

  // Idempotency: при повторному запуску (наприклад, після падіння посеред циклу)
  // вже залиті шортси не заливаються вдруге.
  const alreadyUploaded = new Set(
    (readJsonSafe(statePath, {}).outputs?.youtubeShortsIds || []).map(s => s.clipId)
  );

  let scheduled = 0;
  for (let i = 0; i < shortClipIds.length; i++) {
    const clipId = shortClipIds[i];
    if (alreadyUploaded.has(clipId)) {
      console.log(`[SKIP] Already uploaded: ${clipId}`);
      scheduled++;
      continue;
    }
    const shortPath = path.join(shortsDir, `${clipId}.mp4`);
    if (!fs.existsSync(shortPath)) {
      console.log(`[SKIP] Short not found: ${clipId}`);
      continue;
    }
    const shortPublishTime = new Date(mainPublishTime.getTime() + (scheduled + 1) * intervalMs);
    // YouTube requires publishAt to be at least 5 minutes in the future
    const minTime = new Date(Date.now() + 5 * 60 * 1000);
    const actualPublishTime = shortPublishTime < minTime ? minTime : shortPublishTime;

    await uploadShort(runId, clipId, shortPath, mainVideoId, null, actualPublishTime.toISOString());
    alreadyUploaded.add(clipId);
    scheduled++;
  }

  console.log(`\n✅ Done. Main video published + ${scheduled} shorts scheduled.`);
  console.log(`   Main:   https://youtu.be/${mainVideoId}`);
  const intervalMin = intervalMs / 60000;
  console.log(`   Shorts: published every ${intervalMin}min starting ${new Date(mainPublishTime.getTime() + intervalMs).toLocaleTimeString()}`);

  const finalState = updateState(projectDir, s => {
    s.stages.publish = 'done';
    s.status = 'published';
  });


  // Cleanup large intermediate files
  const { execFileSync } = require('child_process');
  try {
    console.log('\n[cleanup] Removing intermediate files...');
    execFileSync(process.execPath, ['scripts/cleanup-episode.js', runId], { stdio: 'inherit' });
  } catch (e) {
    console.warn('[cleanup] Warning:', e.message);
  }
}

async function updateThumbnail(videoId, thumbnailPath) {
  if (!videoId || !thumbnailPath) throw new Error('Usage: update-thumbnail <videoId> <thumbnailPath>');
  if (!fs.existsSync(thumbnailPath)) throw new Error(`Thumbnail not found: ${thumbnailPath}`);
  const auth = await getAuth();
  const yt = google.youtube({ version: 'v3', auth });
  const mimeType = thumbnailPath.endsWith('.jpg') || thumbnailPath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  await yt.thumbnails.set({ videoId, media: { mimeType, body: fs.createReadStream(thumbnailPath) } });
  console.log(`Thumbnail updated: https://youtu.be/${videoId}`);
}

const [,, cmd, ...args] = process.argv;
const cmds = {
  'upload-video':     () => uploadVideo(...args),
  'upload-short':     () => uploadShort(...args),
  'publish-video':    () => publishVideo(args[0]),
  'publish-all':      () => publishAll(args[0], args[1], args[2], args[3], args[4]),
  'update-thumbnail': () => updateThumbnail(args[0], args[1]),
};
if (!cmds[cmd]) { console.error('Unknown command:', cmd, '\nValid: upload-video, upload-short, publish-video, publish-all'); process.exit(1); }
cmds[cmd]().catch(e => { console.error('Error:', e.message); process.exit(1); });
