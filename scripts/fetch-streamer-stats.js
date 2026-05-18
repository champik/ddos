'use strict';
// fetch-streamer-stats.js — get avg_viewers per broadcaster via TwitchTracker (cached)
// Cache: cache/streamer-stats.json, TTL 7 days
// Fallback: Twitch API follower_count / 20, then default 1000

const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_FILE = path.join('cache', 'streamer-stats.json');
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const REQUEST_DELAY_MS = 1500;

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveCache(cache) {
  fs.mkdirSync('cache', { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpsGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchFromTwitchTracker(broadcaster) {
  const url = `https://twitchtracker.com/${encodeURIComponent(broadcaster.toLowerCase())}`;
  const html = await httpsGetText(url);

  // TwitchTracker shows avg viewers as a number near "average viewers" text
  // Patterns: "8,006" or "8006" near "Average viewers" or "Avg. viewers"
  // Structure: <div class="g-x-s-value ...">8006</div><div class="g-x-s-label color-viewers">Average viewers</div>
  const m = html.match(/class="g-x-s-value[^"]*">([\d,]+)<\/div>\s*<div class="g-x-s-label[^"]*color-viewers/);
  if (m) {
    const val = parseInt(m[1].replace(/,/g, ''), 10);
    if (val > 0) return val;
  }
  return null;
}

async function fetchFromTwitchApi(broadcaster, token, clientId) {
  if (!token || !clientId) return null;
  try {
    const searchUrl = `https://api.twitch.tv/helix/users?login=${encodeURIComponent(broadcaster)}`;
    const res = await httpsGetJson(searchUrl, {
      'Client-ID': clientId,
      'Authorization': `Bearer ${token}`
    });
    const userId = res.data?.[0]?.id;
    if (!userId) return null;

    const chanUrl = `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${userId}&first=1`;
    const chanRes = await httpsGetJson(chanUrl, {
      'Client-ID': clientId,
      'Authorization': `Bearer ${token}`
    });
    const followers = chanRes.total || 0;
    return Math.max(100, Math.round(followers / 20));
  } catch {
    return null;
  }
}

async function fetchStreamerStats(broadcasters, twitchToken = null, twitchClientId = null) {
  const cache = loadCache();
  const now = Date.now();
  const result = new Map();
  const toFetch = [];

  for (const name of broadcasters) {
    const key = name.toLowerCase();
    const entry = cache[key];
    if (entry && (now - new Date(entry.fetched_at).getTime()) < CACHE_TTL_MS) {
      result.set(name, entry.avg_viewers);
    } else {
      toFetch.push(name);
    }
  }

  if (toFetch.length > 0) {
    console.log(`  [virality] Fetching stats for ${toFetch.length} streamers (${result.size} cached)...`);
  }

  for (let i = 0; i < toFetch.length; i++) {
    const name = toFetch[i];
    const key = name.toLowerCase();
    let avgViewers = null;
    let source = 'default';

    try {
      avgViewers = await fetchFromTwitchTracker(name);
      if (avgViewers) source = 'twitchtracker';
    } catch (e) {
      // TwitchTracker failed — try Twitch API
    }

    if (!avgViewers) {
      try {
        avgViewers = await fetchFromTwitchApi(name, twitchToken, twitchClientId);
        if (avgViewers) source = 'twitch_api';
      } catch {}
    }

    if (!avgViewers) {
      avgViewers = 1000;
      source = 'default';
    }

    cache[key] = { avg_viewers: avgViewers, fetched_at: new Date().toISOString(), source };
    result.set(name, avgViewers);
    process.stdout.write(`    ${name}: ${avgViewers} (${source})\n`);

    if (i < toFetch.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  if (toFetch.length > 0) saveCache(cache);

  return result;
}

module.exports = { fetchStreamerStats };

// CLI test: node scripts/fetch-streamer-stats.js shroud xqc
if (require.main === module) {
  const names = process.argv.slice(2);
  if (!names.length) { console.error('Usage: node fetch-streamer-stats.js <streamer> [...]'); process.exit(1); }
  fetchStreamerStats(names).then(map => {
    console.log('\nResults:');
    for (const [k, v] of map) console.log(`  ${k}: ${v} avg viewers`);
  }).catch(e => { console.error(e.message); process.exit(1); });
}
