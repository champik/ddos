'use strict';
// twitch-api.js — Twitch Helix client with retry/backoff. Single source of truth
// so one-off/manual scripts don't hand-copy this logic and silently diverge
// (e.g. skipping VOD enrichment, as happened when Episode_48's 72h top-up was
// done by hand instead of through ingest.js).

const https = require('https');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// App access token via client_credentials — needed by any script that talks
// to Twitch outside the main ingest.js run (e.g. gaming-screen.js's backfill
// rounds), since createTwitchClient() takes a token, it doesn't fetch one.
function fetchAppAccessToken(clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const body = `client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;
    const req = https.request({
      hostname: 'id.twitch.tv', path: '/oauth2/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.access_token) return reject(new Error('No access_token: ' + data));
          resolve(parsed.access_token);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function createTwitchClient(clientId, token) {
  function httpsGetOnce(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${token}` }
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
  }

  // 401 → зрозуміла помилка одразу; 429/5xx → retry з backoff
  async function httpsGet(url, attempts = 4) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      let res;
      try { res = await httpsGetOnce(url); }
      catch (e) { lastErr = e; await sleep(1000 * 2 ** i); continue; }

      if (res.status === 401) {
        throw new Error('Twitch API 401 — токен недійсний або протух. Онови TWITCH_TOKEN.');
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseInt(res.headers['ratelimit-reset'] || res.headers['retry-after'] || '0', 10);
        const waitMs = res.status === 429 && retryAfter
          ? Math.max(0, retryAfter * 1000 - Date.now()) || 1000 * 2 ** i
          : 1000 * 2 ** i;
        lastErr = new Error(`Twitch API ${res.status}`);
        await sleep(Math.min(waitMs, 15000));
        continue;
      }
      try { return JSON.parse(res.body); }
      catch { throw new Error(`JSON parse error (HTTP ${res.status}): ` + res.body.slice(0, 200)); }
    }
    throw lastErr || new Error('Twitch API: всі спроби вичерпано');
  }

  async function getTopGames() {
    const data = await httpsGet('https://api.twitch.tv/helix/games/top?first=50');
    return data.data || [];
  }

  async function fetchClipsPage(gameId, startedAt, after) {
    let url = `https://api.twitch.tv/helix/clips?game_id=${gameId}&started_at=${startedAt}&first=100`;
    if (after) url += `&after=${after}`;
    return httpsGet(url);
  }

  async function fetchClipsForCategory(gameId, startedAt, pages = 5) {
    const clips = [];
    let cursor = null;

    for (let i = 0; i < pages; i++) {
      const page = await fetchClipsPage(gameId, startedAt, cursor);
      if (page.data) clips.push(...page.data);
      cursor = page.pagination?.cursor;
      await sleep(80);
      if (!cursor) break;
    }

    return { clips, nextCursor: cursor };
  }

  // Resolves login → broadcaster_id for a batch of logins (up to 100/request).
  async function getUsersByLogin(logins) {
    const unique = [...new Set(logins.filter(Boolean))];
    const map = new Map();
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      const params = batch.map(l => `login=${encodeURIComponent(l)}`).join('&');
      const data = await httpsGet(`https://api.twitch.tv/helix/users?${params}`);
      for (const u of (data.data || [])) map.set(u.login.toLowerCase(), u.id);
      if (i + 100 < unique.length) await sleep(150);
    }
    return map;
  }

  async function fetchClipsPageForBroadcaster(broadcasterId, startedAt, after) {
    let url = `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}&started_at=${startedAt}&first=100`;
    if (after) url += `&after=${after}`;
    return httpsGet(url);
  }

  // Fetches ALL clips for a broadcaster in the window (no per-category cap —
  // caller filters by view_count afterwards). Safety cap of 20 pages (2000
  // clips) so a runaway pagination loop can't hang the run.
  async function fetchClipsForBroadcaster(broadcasterId, startedAt, maxPages = 20) {
    const clips = [];
    let cursor = null;
    for (let i = 0; i < maxPages; i++) {
      const page = await fetchClipsPageForBroadcaster(broadcasterId, startedAt, cursor);
      if (page.data) clips.push(...page.data);
      cursor = page.pagination?.cursor;
      await sleep(80);
      if (!cursor) break;
    }
    return clips;
  }

  async function fetchClipsPageForBroadcasterAllTime(broadcasterId, after) {
    let url = `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}&first=100`;
    if (after) url += `&after=${after}`;
    return httpsGet(url);
  }

  // Top N clips of all time for a broadcaster — no started_at/ended_at, so
  // Twitch returns clips sorted by view_count descending instead of scoping
  // to an ingest window. Used to build the meme-trailer phrase-search pool,
  // which is independent of any run's ingest window (unlike fetchClipsForBroadcaster).
  async function fetchTopClipsForBroadcaster(broadcasterId, maxClips) {
    const clips = [];
    let cursor = null;
    while (clips.length < maxClips) {
      const page = await fetchClipsPageForBroadcasterAllTime(broadcasterId, cursor);
      if (page.data) clips.push(...page.data);
      cursor = page.pagination?.cursor;
      await sleep(80);
      if (!cursor || !page.data || page.data.length === 0) break;
    }
    return clips.slice(0, maxClips);
  }

  // Resolves game_id → name for a batch of ids (up to 100/request). Clips
  // fetched by broadcaster (not by category) don't come pre-labeled with
  // game_name the way ingest.js's category loop labels them.
  async function getGamesByIds(gameIds) {
    const unique = [...new Set(gameIds.filter(Boolean))];
    const map = new Map();
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      const params = batch.map(id => `id=${encodeURIComponent(id)}`).join('&');
      const data = await httpsGet(`https://api.twitch.tv/helix/games?${params}`);
      for (const g of (data.data || [])) map.set(g.id, g.name);
      if (i + 100 < unique.length) await sleep(150);
    }
    return map;
  }

  // Batch-fetches channel tags for the given broadcaster_ids and returns the
  // subset tagged "vtuber".
  async function fetchVtuberBroadcasterIds(broadcasterIds) {
    const unique = [...new Set(broadcasterIds.filter(Boolean))];
    const vtuberIds = new Set();
    const BATCH_SIZE = 100;
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      const batch = unique.slice(i, i + BATCH_SIZE);
      const params = batch.map(id => `broadcaster_id=${id}`).join('&');
      try {
        const data = await httpsGet(`https://api.twitch.tv/helix/channels?${params}`);
        for (const ch of (data.data || [])) {
          const tags = (ch.tags || []).map(t => t.toLowerCase());
          if (tags.includes('vtuber')) vtuberIds.add(ch.broadcaster_id);
        }
      } catch (e) {
        console.warn(`  [WARN] channel tags fetch failed: ${e.message}`);
      }
      if (i + BATCH_SIZE < unique.length) await sleep(200);
    }
    return vtuberIds;
  }

  // Batch-fetches VOD created_at for the given video_ids.
  // Returns Map<video_id, created_at ISO string>.
  async function fetchVodCreatedTimes(videoIds) {
    const unique = [...new Set(videoIds.filter(Boolean))];
    const vodMap = new Map();
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      const params = batch.map(id => `id=${encodeURIComponent(id)}`).join('&');
      try {
        const data = await httpsGet(`https://api.twitch.tv/helix/videos?${params}`);
        for (const vod of (data.data || [])) vodMap.set(vod.id, vod.created_at);
      } catch (e) {
        console.warn(`  [WARN] VOD fetch failed: ${e.message}`);
      }
      if (i + 100 < unique.length) await sleep(150);
    }
    return vodMap;
  }

  return {
    httpsGet, getTopGames, fetchClipsPage, fetchClipsForCategory, fetchVtuberBroadcasterIds, fetchVodCreatedTimes,
    getUsersByLogin, fetchClipsForBroadcaster, getGamesByIds, fetchTopClipsForBroadcaster,
  };
}

module.exports = { createTwitchClient, sleep, fetchAppAccessToken };
