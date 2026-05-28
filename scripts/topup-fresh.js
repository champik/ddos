'use strict';
// topup-fresh.js — fetch N new JC/IRL clips from last 24h, skip known streamers
// Usage: node scripts/topup-fresh.js <runId> [--limit N]

const fs   = require('fs');
const path = require('path');
const https= require('https');
const { execSync } = require('child_process');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node scripts/topup-fresh.js <runId>'); process.exit(1); }
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1]) : 10;
const HOURS = 24;

const PROJECT_DIR = path.join('projects', runId);
const CLIPS_DIR   = path.join(PROJECT_DIR, 'clips');
const DL_DIR      = path.join(PROJECT_DIR, 'downloads');

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
    const req = https.get(url, { headers }, res => {
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
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': data.length }
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const RU_KW = ['русский','россия','russian','путін','рф'];
const ORG   = new Set(['esl_csgo','eslcs','blasttv','pgl','riotgames','valorant','esl_dota2','weplay_esports','faceit','dreamhack','esltv','iem']);

function isRu(c) {
  if (c.language === 'ru') return true;
  if (RU_KW.some(k=>(c.title||'').toLowerCase().includes(k))) return true;
  if (/[а-яё]/i.test(c.broadcaster_name||'')) return true;
  return false;
}

async function main() {
  const tokenRes = await httpsPost('https://id.twitch.tv/oauth2/token',
    `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`);
  const token = tokenRes.access_token;
  const headers = { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${token}` };

  const dlPath = path.join(CLIPS_DIR, 'downloaded-clips.json');
  const existing = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
  const existingIds = new Set(existing.map(c => c.id));
  const existingStreamers = new Set(existing.map(c => c.broadcaster_name.toLowerCase()));
  console.log(`Already have: ${existing.length} clips from ${existingStreamers.size} streamers`);

  const startedAt = new Date(Date.now() - HOURS * 3600000).toISOString();
  const CATS = [['509658','Just Chatting'],['509672','IRL']];
  let candidates = [];

  for (const [gameId, gameName] of CATS) {
    let cursor = '';
    for (let page = 0; page < 8; page++) {
      const url = `https://api.twitch.tv/helix/clips?game_id=${gameId}&started_at=${startedAt}&first=20${cursor ? '&after='+cursor : ''}`;
      try {
        const res = await httpsGet(url, headers);
        const clips = (res.data||[]).map(c => ({...c, game_name: gameName}));
        candidates.push(...clips);
        cursor = res.pagination?.cursor || '';
        if (!cursor) break;
        await sleep(250);
      } catch(e) { console.warn(`  ${gameName} page error: ${e.message}`); break; }
    }
    console.log(`${gameName}: fetched so far ${candidates.length}`);
  }

  // Deduplicate
  const seen = new Set();
  candidates = candidates.filter(c => { if(seen.has(c.id)) return false; seen.add(c.id); return true; });

  // Filter
  const filtered = candidates.filter(c => {
    if (existingIds.has(c.id)) return false;
    if (existingStreamers.has(c.broadcaster_name.toLowerCase())) return false; // skip known streamers
    if (isRu(c)) return false;
    if (ORG.has((c.broadcaster_name||'').toLowerCase())) return false;
    if (c.duration < 6 || c.duration > 90) return false;
    if (['ja','ko','zh','th'].includes(c.language)) return false;
    if (c.language !== 'en' && c.language !== 'uk') return false;
    const t = (c.title||'').toLowerCase();
    if ([' major',' grand final','championship',' tournament','qualifier'].some(k=>t.includes(k))) return false;
    return true;
  });

  console.log(`Filtered: ${filtered.length} new clips from new streamers`);

  // Sort by velocity (views/hour)
  const now = Date.now();
  const sorted = filtered.map(c => {
    const h = Math.max((now - new Date(c.created_at))/3600000, 0.5);
    return {...c, velocity: c.view_count / h};
  }).sort((a,b) => b.velocity - a.velocity);

  const toDownload = sorted.slice(0, LIMIT);

  console.log(`\nDownloading top ${toDownload.length}:`);
  toDownload.forEach((c,i) =>
    console.log(`  [${i+1}] ${c.broadcaster_name} — "${c.title.slice(0,55)}" (${c.view_count} views, ${c.language}, ${c.duration}s)`)
  );

  fs.mkdirSync(DL_DIR, { recursive: true });
  const downloaded = [];

  for (let i = 0; i < toDownload.length; i++) {
    const c = toDownload[i];
    const cat = (c.game_name||'unknown').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
    const streamer = c.broadcaster_name.toLowerCase().replace(/[^a-z0-9]+/g,'_');
    const date = c.created_at.slice(0,10).replace(/-/g,'_');
    const filename = `${cat}_${streamer}_${c.view_count}_${date}.mp4`;
    const outPath = path.join(DL_DIR, filename);

    process.stdout.write(`  [${i+1}/${toDownload.length}] ${c.broadcaster_name}...`);

    if (fs.existsSync(outPath)) { console.log(' [skip]'); downloaded.push({...c, localPath:`projects/${runId}/downloads/${filename}`}); continue; }

    try {
      execSync(`python -m yt_dlp --no-playlist --format "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 --output "${outPath}" --quiet "${c.url}"`, { timeout: 90000 });
      if (fs.existsSync(outPath)) { console.log(' [OK]'); downloaded.push({...c, localPath:`projects/${runId}/downloads/${filename}`}); }
      else { console.log(' [FAIL - no file]'); }
    } catch(e) { console.log(` [FAIL]`); }
  }

  console.log(`\nDownloaded: ${downloaded.length}/${toDownload.length}`);

  const merged = [...existing, ...downloaded];
  fs.writeFileSync(dlPath, JSON.stringify(merged, null, 2));
  console.log(`downloaded-clips.json: ${merged.length} total`);
}

main().catch(e => { console.error(e); process.exit(1); });
