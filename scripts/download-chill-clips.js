'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const PROJECT_DIR = 'projects/Episode_2_2026_05_17';

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0,200))); } });
    }).on('error', reject);
  });
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(body);
    const opts = { hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': data.length } };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function sanitize(s) { return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,''); }

function buildFilename(clip) {
  const cat = sanitize(clip.game_name||'music');
  const streamer = sanitize(clip.broadcaster_name);
  const date = (clip.created_at||'').slice(0,10).replace(/-/g,'_');
  return `${cat}_${streamer}_${clip.view_count}_${date}.mp4`;
}

async function main() {
  const tokenResp = await httpsPost(
    'https://id.twitch.tv/oauth2/token',
    `client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`
  );
  const token = tokenResp.access_token;
  const headers = { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` };

  const startedAt = new Date(Date.now() - 72 * 3600000).toISOString();

  // Load existing
  const existing = JSON.parse(fs.readFileSync(`${PROJECT_DIR}/clips/downloaded-clips.json`, 'utf8'));
  const existingIds = new Set(existing.map(c => c.id));

  const RU_WORDS = ['русский','россия','russian','путін','рф','москва','питер'];
  const BLACKLIST = new Set(['lyasyaa']);

  // Fetch candidates
  const allClips = [];
  for (const gameId of ['509658','509672','26936']) {
    const gameName = { '509658': 'Just Chatting', '509672': 'IRL', '26936': 'Music' }[gameId];
    let cursor = '';
    for (let page = 1; page <= 4; page++) {
      let url = `https://api.twitch.tv/helix/clips?game_id=${gameId}&started_at=${startedAt}&first=20`;
      if (cursor) url += `&after=${cursor}`;
      const resp = await httpsGet(url, headers);
      const data = resp.data || [];
      data.forEach(c => { if (!c.game_name) c.game_name = gameName; });
      allClips.push(...data);
      cursor = resp.pagination?.cursor || '';
      if (!cursor) break;
    }
  }

  // Filter
  const filtered = allClips.filter(c => {
    if (existingIds.has(c.id)) return false;
    if (c.language === 'ru') return false;
    if (BLACKLIST.has((c.broadcaster_name||'').toLowerCase())) return false;
    if (c.duration < 8 || c.duration > 90) return false;
    const title = (c.title||'').toLowerCase();
    if (RU_WORDS.some(w => title.includes(w))) return false;
    return true;
  });

  // Select 20: prioritize Music category, then EN JC/IRL
  const musicClips = filtered.filter(c => c.game_id === '26936' && c.language === 'en').slice(0, 10);
  const enClips = filtered.filter(c => c.game_id !== '26936' && c.language === 'en').slice(0, 8);
  const otherClips = filtered.filter(c => !['en'].includes(c.language) && ['ja','ko','zh','th'].indexOf(c.language) === -1).slice(0, 2);

  const toDownload = [...musicClips, ...enClips, ...otherClips].slice(0, 20);

  console.log(`\nWill download ${toDownload.length} clips:`);
  toDownload.forEach((c,i) => {
    console.log(`[${i+1}] ${c.broadcaster_name.padEnd(20)} ${(c.game_name||'').padEnd(14)} ${String(c.view_count).padStart(7)} views  ${c.duration}s  ${c.language}  ${(c.title||'').slice(0,50)}`);
  });

  const dlDir = `${PROJECT_DIR}/downloads`;
  fs.mkdirSync(dlDir, { recursive: true });

  const downloaded = [];
  for (const clip of toDownload) {
    const filename = buildFilename(clip);
    const outPath = path.join(dlDir, filename);

    if (fs.existsSync(outPath)) {
      console.log(`[SKIP] ${filename} already exists`);
      clip.localPath = outPath;
      downloaded.push(clip);
      continue;
    }

    process.stdout.write(`[DL] ${clip.broadcaster_name.padEnd(20)} ${filename.slice(0,50).padEnd(50)} `);
    const r = spawnSync('python', ['-m', 'yt_dlp',
      '--no-playlist',
      '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--output', outPath,
      '--quiet',
      clip.url
    ], { stdio: 'pipe', encoding: 'utf8', timeout: 60000 });

    if (r.status === 0 && fs.existsSync(outPath)) {
      const stat = fs.statSync(outPath);
      console.log(`OK (${(stat.size/1024/1024).toFixed(1)}MB)`);
      clip.localPath = outPath;
      downloaded.push(clip);
    } else {
      console.log(`FAIL: ${(r.stderr||'').slice(-80)}`);
    }
  }

  // Append to downloaded-clips.json
  const all = [...existing, ...downloaded];
  fs.writeFileSync(`${PROJECT_DIR}/clips/downloaded-clips.json`, JSON.stringify(all, null, 2));

  // Save new clips separately for scoring
  fs.writeFileSync('scripts/_new-chill-clips.json', JSON.stringify(downloaded, null, 2));

  console.log(`\nDownloaded ${downloaded.length}/${toDownload.length} clips`);
  console.log(`Total in downloaded-clips.json: ${all.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
