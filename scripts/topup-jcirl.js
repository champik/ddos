'use strict';
// topup-jcirl.js — fetch 20 more JC/IRL clips, skipping already-downloaded ones
// Usage: node scripts/topup-jcirl.js <runId> [--hours N] [--limit N]

const fs   = require('fs');
const path = require('path');
const https= require('https');
const { execSync } = require('child_process');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node scripts/topup-jcirl.js <runId>'); process.exit(1); }
const hoursArg = process.argv.indexOf('--hours');
const HOURS = hoursArg !== -1 ? parseInt(process.argv[hoursArg + 1]) : 36; // wider window for more variety
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1]) : 20;
const pagesArg = process.argv.indexOf('--pages');
const PAGES = pagesArg !== -1 ? parseInt(process.argv[pagesArg + 1]) : 6;

const PROJECT_DIR = path.join('projects', runId);
const CLIPS_DIR   = path.join(PROJECT_DIR, 'clips');
const DL_DIR      = path.join(PROJECT_DIR, 'downloads');

// Load env
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}
const CLIENT_ID     = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(data.slice(0,300))); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const u = new URL(url);
    const options = {
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': data.length }
    };
    const req = https.request(options, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const RU_KEYWORDS = ['русский','россия','russian','путін','рф','russki','rossia'];
const ORG_ACCOUNTS = new Set(['esl_csgo','eslcs','eslcsb','blasttv','pgl','riotgames','valorant','esl_dota2','weplay_esports','faceit','dreamhack','esltv','iem','pubg_battlegrounds']);

function isGambling(clip) {
  const name = (clip.game_name || '').toLowerCase();
  return ['slots','casino','gambling','betting','poker'].some(k => name.includes(k));
}

async function main() {
  // Get token
  const tokenRes = await httpsPost(
    'https://id.twitch.tv/oauth2/token',
    `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`
  );
  const token = tokenRes.access_token;
  const headers = { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${token}` };
  console.log('✓ Token obtained');

  // Load existing downloaded clip IDs
  const dlPath = path.join(CLIPS_DIR, 'downloaded-clips.json');
  const existing = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
  const existingIds = new Set(existing.map(c => c.id));
  const existingStreamers = new Set(existing.map(c => c.broadcaster_name.toLowerCase()));
  console.log(`Existing: ${existing.length} clips, ${existingStreamers.size} streamers`);

  const startedAt = new Date(Date.now() - HOURS * 3600000).toISOString();
  const JC_IRL_IDS = ['509658', '509672'];
  const catNames   = ['Just Chatting', 'IRL'];

  let candidates = [];

  for (let i = 0; i < JC_IRL_IDS.length; i++) {
    const gameId = JC_IRL_IDS[i];
    const gameName = catNames[i];
    console.log(`\nFetching ${gameName} (${gameId})...`);

    // Fetch multiple pages to get enough candidates
    let cursor = '';
    let pagesLeft = PAGES; // up to PAGES*20 clips per category
    let pageFetched = 0;

    while (pagesLeft-- > 0) {
      const url = `https://api.twitch.tv/helix/clips?game_id=${gameId}&started_at=${startedAt}&first=20${cursor ? '&after=' + cursor : ''}`;
      try {
        const res = await httpsGet(url, headers);
        const clips = (res.data || []).map(c => ({ ...c, game_name: gameName }));
        candidates.push(...clips);
        pageFetched++;
        cursor = res.pagination?.cursor || '';
        if (!cursor) break;
        await sleep(300);
      } catch(e) {
        console.warn(`  Page error: ${e.message}`);
        break;
      }
    }
    console.log(`  Pages: ${pageFetched}`);
  }

  console.log(`\nRaw candidates: ${candidates.length}`);

  // Deduplicate
  const seen = new Set();
  candidates = candidates.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });

  // Filter
  const rejected = [];
  const filtered = candidates.filter(c => {
    if (existingIds.has(c.id))       { rejected.push({id:c.id,reason:'already_downloaded'}); return false; }
    if (c.language !== 'en')         { rejected.push({id:c.id,reason:'non_english'}); return false; }
    if (isGambling(c))               { rejected.push({id:c.id,reason:'gambling'}); return false; }
    if (ORG_ACCOUNTS.has((c.broadcaster_name||'').toLowerCase())) { rejected.push({id:c.id,reason:'org'}); return false; }
    if (c.duration < 6 || c.duration > 90) { rejected.push({id:c.id,reason:'duration'}); return false; }
    const title = (c.title||'').toLowerCase();
    if (RU_KEYWORDS.some(k => title.includes(k))) { rejected.push({id:c.id,reason:'ru_keyword'}); return false; }
    if ([' major',' grand final','championship',' tournament','qualifier'].some(k=>title.includes(k)))
      { rejected.push({id:c.id,reason:'tournament'}); return false; }
    return true;
  });

  console.log(`After filter: ${filtered.length} (rejected ${rejected.length})`);

  // Sort by velocity (views/hour)
  const now = Date.now();
  function velocity(c) {
    return c.view_count / Math.max((now - new Date(c.created_at)) / 3600000, 0.5);
  }
  const scored = [...filtered].sort((a, b) => velocity(b) - velocity(a));

  // Prefer new streamers (not in existing), but allow repeats
  const newStreamers = scored.filter(c => !existingStreamers.has(c.broadcaster_name.toLowerCase()));
  const repeatStreamers = scored.filter(c => existingStreamers.has(c.broadcaster_name.toLowerCase()));

  // Build top list: prefer new streamers first, then fill with repeats
  const toDownload = [];
  const dlSeenStreamers = new Map();
  const allOrdered = [...newStreamers, ...repeatStreamers];
  for (const c of allOrdered) {
    if (toDownload.length >= LIMIT) break;
    const sc = dlSeenStreamers.get(c.broadcaster_name) || 0;
    if (sc >= 2) continue; // max 2 new clips per streamer
    toDownload.push(c);
    dlSeenStreamers.set(c.broadcaster_name, sc + 1);
  }

  console.log(`\nTo download: ${toDownload.length} clips`);
  toDownload.slice(0,20).forEach((c,i) =>
    console.log(`  [${i+1}] ${c.broadcaster_name} — ${c.title.slice(0,50)} (views:${c.view_count}, vel:${velocity(c).toFixed(0)}/hr, lang:${c.language})`)
  );

  // Download
  fs.mkdirSync(DL_DIR, { recursive: true });
  const downloaded = [];
  const downloadErrors = [];

  for (let i = 0; i < toDownload.length; i++) {
    const c = toDownload[i];
    const cat = (c.game_name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
    const streamer = c.broadcaster_name.toLowerCase().replace(/[^a-z0-9]+/g,'_');
    const date = c.created_at.slice(0,10).replace(/-/g,'_');
    const filename = `${cat}_${streamer}_${c.view_count}_${date}.mp4`;
    const outPath = path.join(DL_DIR, filename);

    process.stdout.write(`  [${i+1}/${toDownload.length}] ${c.broadcaster_name}...`);

    if (fs.existsSync(outPath)) {
      console.log(' [SKIP exists]');
      downloaded.push({ ...c, localPath: `projects/${runId}/downloads/${filename}` });
      continue;
    }

    try {
      execSync(
        `python -m yt_dlp --no-playlist --format "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 --output "${outPath}" --quiet "${c.url}"`,
        { timeout: 90000 }
      );
      if (fs.existsSync(outPath)) {
        console.log(' [OK]');
        downloaded.push({ ...c, localPath: `projects/${runId}/downloads/${filename}` });
      } else {
        console.log(' [FAIL - no file]');
        downloadErrors.push(c.id);
      }
    } catch(e) {
      console.log(` [FAIL: ${e.message.slice(0,60)}]`);
      downloadErrors.push(c.id);
    }
  }

  console.log(`\nDownloaded: ${downloaded.length}, errors: ${downloadErrors.length}`);

  // Merge into downloaded-clips.json
  const merged = [...existing, ...downloaded];
  fs.writeFileSync(dlPath, JSON.stringify(merged, null, 2));
  console.log(`downloaded-clips.json updated: ${merged.length} total`);

  // Save topup candidates for reference
  fs.writeFileSync(path.join(CLIPS_DIR, 'topup-jcirl-candidates.json'), JSON.stringify(scored.slice(0, 50), null, 2));
  console.log('Done ✓');

  return downloaded;
}

main().catch(e => { console.error(e); process.exit(1); });
