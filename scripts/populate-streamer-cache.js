'use strict';
// populate-streamer-cache.js — pre-populate cache with top 1000 English streamers from TwitchTracker
// Run once: node scripts/populate-streamer-cache.js
// Then ingest-run.js will only fetch new streamers not in cache

const fs = require('fs');
const https = require('https');
const path = require('path');

const CACHE_FILE = path.join('cache', 'streamer-stats.json');
const PAGES = 40; // ~25 streamers/page = ~1000 total
const DELAY_MS = 1200;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchPage(page) {
  return new Promise((resolve, reject) => {
    const url = `https://twitchtracker.com/channels/ranking/english?page=${page}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject).setTimeout(15000, function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

function parseStreamers(html) {
  const results = [];
  // Pattern: href="/streamer" target="_blank">DisplayName</a></td> ... <td class="color-viewers"><span ...>40068</span>
  const rowPattern = /href="\/([a-z0-9_]+)" target="_blank">[^<]+<\/a><\/td>\s*(?:<td[^>]*>.*?<\/td>\s*)?<td[^>]*class="color-viewers"[^>]*><span[^>]*>([\d,]+)<\/span>/gs;
  let m;
  while ((m = rowPattern.exec(html)) !== null) {
    const name = m[1];
    const avgViewers = parseInt(m[2].replace(/,/g, ''), 10);
    // skip nav links and non-streamer paths
    const NAV = new Set(['games','clips','statistics','languages','subscribers','channels','streams','viewership']);
    if (!NAV.has(name) && avgViewers > 0) {
      results.push({ name, avgViewers });
    }
  }
  return results;
}

async function main() {
  fs.mkdirSync('cache', { recursive: true });

  let cache = {};
  if (fs.existsSync(CACHE_FILE)) {
    try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
  }

  const existing = Object.keys(cache).length;
  console.log(`Existing cache entries: ${existing}`);
  console.log(`Fetching top ~${PAGES * 25} English streamers from TwitchTracker...\n`);

  let totalAdded = 0;
  let totalSkipped = 0;

  for (let page = 1; page <= PAGES; page++) {
    process.stdout.write(`Page ${String(page).padStart(2)}/${PAGES}: `);
    try {
      const html = await fetchPage(page);
      const streamers = parseStreamers(html);

      if (streamers.length === 0) {
        console.log('no streamers found — stopping');
        break;
      }

      let added = 0;
      for (const { name, avgViewers } of streamers) {
        const key = name.toLowerCase();
        if (!cache[key]) {
          cache[key] = { avg_viewers: avgViewers, fetched_at: new Date().toISOString(), source: 'ranking_page' };
          added++;
          totalAdded++;
        } else {
          totalSkipped++;
        }
      }

      const names = streamers.map(s => s.name).join(', ');
      console.log(`${streamers.length} streamers (+${added} new) — ${names.slice(0, 80)}...`);

    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }

    if (page < PAGES) await sleep(DELAY_MS);
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

  const total = Object.keys(cache).length;
  console.log(`\nDone. Cache: ${total} streamers total (+${totalAdded} added, ${totalSkipped} already cached)`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
