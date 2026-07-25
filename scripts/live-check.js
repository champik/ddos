#!/usr/bin/env node
// live-check.js — перевіряє хто з епізодних стрімерів зараз онлайн на Twitch
// Usage: node scripts/live-check.js [episodeNumber]

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { readJsonSafe } = require('./lib/state');

require('./lib/env').loadEnv();

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

async function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error(`JSON parse error (HTTP ${res.status}): ` + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function getToken() {
  const res = await httpsRequest({
    hostname: 'id.twitch.tv',
    path: `/oauth2/token?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '0' }
  });
  if (res.status !== 200) throw new Error(`Token request failed: ${res.status} — ${JSON.stringify(res.body)}`);
  return res.body.access_token;
}

async function getStreams(token, logins) {
  const all = [];
  for (let i = 0; i < logins.length; i += 100) {
    const chunk = logins.slice(i, i + 100);
    const params = chunk.map(l => `user_login=${encodeURIComponent(l)}`).join('&');
    const res = await httpsRequest({
      hostname: 'api.twitch.tv',
      path: `/helix/streams?${params}&first=100`,
      method: 'GET',
      headers: { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${token}` }
    });
    if (res.status !== 200) throw new Error(`Streams API error: ${res.status} — ${JSON.stringify(res.body)}`);
    all.push(...(res.body.data || []));
  }
  return all;
}

function getEpisodeDirs() {
  const { findAllProjects } = require('./lib/project-path');
  return findAllProjects()
    .filter(({ runId }) => /^Episode_\d+_\d{4}_\d{2}_\d{2}$/.test(runId))
    .map(({ runId, projectDir }) => {
      const m = runId.match(/^Episode_(\d+)_/);
      return { name: runId, num: parseInt(m[1]), dir: projectDir };
    })
    .sort((a, b) => b.num - a.num);
}

function getStreamersFromEpisode(episodeDir, episodeNum) {
  const plan = readJsonSafe(path.join(episodeDir, 'edit', 'episode-plan.json'));
  const downloaded = readJsonSafe(path.join(episodeDir, 'clips', 'downloaded-clips.json'));
  if (!plan || !downloaded) return null;

  const clipMap = Object.fromEntries(downloaded.map(c => [c.id, c]));

  const hooksMap = {};
  const metadata = readJsonSafe(path.join(episodeDir, 'exports', 'metadata.json'));
  if (metadata?.clipHooks) {
    for (const h of metadata.clipHooks) hooksMap[h.clipId] = h.hook;
  }

  const usedClipIds = (plan.clipOrder || []).filter(id => !id.startsWith('__'));

  const streamers = {};
  for (const clipId of usedClipIds) {
    const clip = clipMap[clipId];
    if (!clip) continue;
    const login = clip.broadcaster_login || clip.broadcaster_name.toLowerCase();
    if (!streamers[login]) {
      streamers[login] = { displayName: clip.broadcaster_name, login, clips: [], episodeNum };
    }
    streamers[login].clips.push({
      hook: hooksMap[clipId] || clip.title || null,
      category: clip.game_name || clip._categoryName,
      viewCount: clip.view_count,
      url: clip.url || null,
    });
  }
  return streamers;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const epArg = args.find(a => /^\d+$/.test(a));
  const episodeNum = epArg ? parseInt(epArg) : null;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Помилка: TWITCH_CLIENT_ID або TWITCH_CLIENT_SECRET не знайдено в .env');
    process.exit(1);
  }

  const allEpisodes = getEpisodeDirs();
  if (allEpisodes.length === 0) {
    console.log('Епізодів не знайдено.');
    return;
  }

  let targetEpisodes;
  if (episodeNum !== null) {
    const ep = allEpisodes.find(e => e.num === episodeNum);
    if (!ep) {
      console.error(`Епізод #${episodeNum} не знайдено.`);
      process.exit(1);
    }
    targetEpisodes = [ep];
  } else {
    targetEpisodes = allEpisodes.slice(0, 7);
  }

  // Збираємо всіх стрімерів з вибраних епізодів
  const allStreamers = {};
  for (const ep of targetEpisodes) {
    const epStreamers = getStreamersFromEpisode(ep.dir, ep.num);
    if (!epStreamers) continue;
    for (const [login, info] of Object.entries(epStreamers)) {
      if (!allStreamers[login]) {
        allStreamers[login] = { displayName: info.displayName, login, appearances: [] };
      }
      allStreamers[login].appearances.push({ episodeNum: info.episodeNum, clips: info.clips });
    }
  }

  // Twitch user_login must be [a-z0-9_] — skip non-ASCII names that slipped through ingest
  const logins = Object.keys(allStreamers).filter(l => /^[a-z0-9_]+$/.test(l));
  if (logins.length === 0) {
    console.log('Стрімерів у вибраних епізодах не знайдено.');
    return;
  }

  console.log(`Перевіряю ${logins.length} стрімерів з ${targetEpisodes.length} епізод(ів)...`);

  const token = await getToken();
  const liveStreams = await getStreams(token, logins);

  const epLabel = episodeNum
    ? `епізоді #${episodeNum}`
    : `останніх ${targetEpisodes.length} епізодах (ep#${targetEpisodes[targetEpisodes.length - 1].num}–#${targetEpisodes[0].num})`;

  if (liveStreams.length === 0) {
    console.log(`\nНіхто з ${epLabel} зараз не стрімить.`);
    return;
  }

  liveStreams.sort((a, b) => b.viewer_count - a.viewer_count);

  if (jsonMode) {
    const result = liveStreams.map(stream => {
      const login = stream.user_login.toLowerCase();
      const info = allStreamers[login];
      return {
        name: stream.user_name,
        login: stream.user_login,
        viewers: stream.viewer_count,
        game: stream.game_name,
        appearances: info.appearances.map(app => ({
          episodeNum: app.episodeNum,
          clips: app.clips.map(c => ({ hook: c.hook, url: c.url })),
        })),
      };
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Flatten: one row per (streamer × episode appearance)
  const rows = [];
  for (const stream of liveStreams) {
    const login = stream.user_login.toLowerCase();
    const info = allStreamers[login];
    info.appearances.forEach((app, i) => {
      const hooks = app.clips.map(c => c.hook || '—').join(', ');
      rows.push({
        streamer: i === 0 ? stream.user_name : '',
        game:     i === 0 ? stream.game_name : '',
        viewers:  i === 0 ? stream.viewer_count.toLocaleString('uk-UA') : '',
        ep:       `#${app.episodeNum}`,
        clips:    hooks,
      });
    });
  }

  const COL = {
    streamer: Math.max(8,  ...rows.map(r => r.streamer.length)),
    game:     Math.max(8,  ...rows.map(r => r.game.length)),
    viewers:  Math.max(8,  ...rows.map(r => r.viewers.length)),
    ep:       4,
  };
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  const header = `${pad('Streamer', COL.streamer)}  ${pad('Категорія', COL.game)}  ${pad('Глядачі', COL.viewers)}  Ep    Кліп(и)`;
  const divider = '─'.repeat(header.length + 20);

  console.log(`\n🔴 Онлайн з ${epLabel} — ${liveStreams.length} з ${logins.length}:\n`);
  console.log(header);
  console.log(divider);
  for (const r of rows) {
    console.log(`${pad(r.streamer, COL.streamer)}  ${pad(r.game, COL.game)}  ${pad(r.viewers, COL.viewers)}  ${pad(r.ep, COL.ep)}  ${r.clips}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
