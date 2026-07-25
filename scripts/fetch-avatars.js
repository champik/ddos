#!/usr/bin/env node
'use strict';
// fetch-avatars.js — fetches Twitch profile images for streamers in the episode
// Reads episode-plan.json → maps broadcaster_ids → GET /helix/users → saves clips/streamer-avatars.json
// Usage: node scripts/fetch-avatars.js <projectDir>

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { readJson, readJsonSafe } = require('./lib/state');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node scripts/fetch-avatars.js <projectDir>'); process.exit(1); }

require('./lib/env').loadEnv();

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

function httpsPost(hostname, path_, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: path_, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(`JSON parse failed: ${d.slice(0, 120)}`)); } });
    }).on('error', reject);
  });
}

async function getToken() {
  const data = await httpsPost('id.twitch.tv', '/oauth2/token',
    `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`);
  if (!data.access_token) throw new Error(`Token fetch failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function main() {
  const plan = readJsonSafe(path.join(projectDir, 'edit/episode-plan.json'), null);
  if (!plan?.clipOrder) throw new Error('episode-plan.json not found or missing clipOrder — run after editorial');

  const downloaded = readJson(path.join(projectDir, 'clips/downloaded-clips.json'));
  const clipMap = Object.fromEntries(downloaded.map(c => [c.id, c]));

  const broadcasterIds = [...new Set(
    plan.clipOrder
      .filter(id => !String(id).startsWith('__recon'))
      .map(id => clipMap[id]?.broadcaster_id)
      .filter(Boolean)
  )];

  if (broadcasterIds.length === 0) {
    console.log('[AVATARS] No broadcaster IDs found');
    fs.writeFileSync(path.join(projectDir, 'clips/streamer-avatars.json'), '{}');
    return;
  }

  const token = await getToken();
  const headers = { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${token}` };

  console.log(`[AVATARS] Fetching profile images for ${broadcasterIds.length} streamers...`);

  const avatars = {}; // broadcaster_id → profile_image_url
  const BATCH = 100;
  for (let i = 0; i < broadcasterIds.length; i += BATCH) {
    const batch = broadcasterIds.slice(i, i + BATCH);
    const qs = batch.map(id => `id=${encodeURIComponent(id)}`).join('&');
    const data = await httpsGet(`https://api.twitch.tv/helix/users?${qs}`, headers);
    for (const user of (data.data || [])) {
      avatars[user.id] = user.profile_image_url;
    }
  }

  fs.writeFileSync(path.join(projectDir, 'clips/streamer-avatars.json'), JSON.stringify(avatars, null, 2));
  console.log(`[AVATARS] Saved ${Object.keys(avatars).length} avatars → clips/streamer-avatars.json`);
}

main().catch(e => { console.error('[FETCH-AVATARS FATAL]', e.message); process.exit(1); });
