'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('JSON parse: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
  });
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const opts = Object.assign(require('url').parse(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': data.length }
    });
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  // Get token
  const tokenResp = await httpsPost(
    'https://id.twitch.tv/oauth2/token',
    `client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`
  );
  const token = tokenResp.access_token;
  if (!token) { console.error('No token:', JSON.stringify(tokenResp)); process.exit(1); }
  console.log('Token OK');

  const headers = { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` };

  const startedAt = new Date(Date.now() - 48 * 3600000).toISOString();
  const GAME_IDS = ['509658', '509672', '26936']; // JC, IRL, Music
  const GAME_NAMES = { '509658': 'Just Chatting', '509672': 'IRL', '26936': 'Music' };

  const allClips = [];
  for (const gameId of GAME_IDS) {
    let cursor = '';
    for (let page = 1; page <= 3; page++) {
      let url = `https://api.twitch.tv/helix/clips?game_id=${gameId}&started_at=${startedAt}&first=20`;
      if (cursor) url += `&after=${cursor}`;
      const resp = await httpsGet(url, headers);
      const data = resp.data || [];
      // Add game_name if missing
      data.forEach(c => { if (!c.game_name) c.game_name = GAME_NAMES[gameId]; });
      allClips.push(...data);
      cursor = resp.pagination?.cursor || '';
      console.log(`  ${GAME_NAMES[gameId]} page ${page}: ${data.length} clips (cursor: ${cursor ? 'yes' : 'no'})`);
      if (!cursor) break;
    }
  }
  console.log(`Total fetched: ${allClips.length}`);

  // Load existing downloaded clips
  const existingPath = 'projects/Episode_2_2026_05_17/clips/downloaded-clips.json';
  const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
  const existingIds = new Set(existing.map(c => c.id));
  console.log(`Existing downloaded: ${existingIds.size}`);

  const RU_WORDS = ['русский', 'россия', 'russian', 'путін', 'рф', 'москва', 'питер'];
  const BLACKLIST = new Set(['lyasyaa']);

  const filtered = allClips.filter(c => {
    if (existingIds.has(c.id)) return false;
    if (c.language === 'ru') return false;
    if (BLACKLIST.has((c.broadcaster_name || '').toLowerCase())) return false;
    if (c.duration < 6 || c.duration > 90) return false;
    const title = (c.title || '').toLowerCase();
    if (RU_WORDS.some(w => title.includes(w))) return false;
    return true;
  });

  // Sort by view_count
  filtered.sort((a, b) => b.view_count - a.view_count);
  console.log(`Filtered new candidates: ${filtered.length}`);
  console.log('');

  // Show top 30
  filtered.slice(0, 30).forEach((c, i) => {
    console.log(`[${String(i+1).padStart(2)}] ${c.broadcaster_name.padEnd(20)} ${(c.game_name||'').padEnd(14)} ${String(c.view_count).padStart(8)} views  ${c.duration}s  ${c.language}  ${(c.title||'').slice(0, 55)}`);
  });

  // Save to temp file
  fs.writeFileSync('scripts/_chill-candidates.json', JSON.stringify(filtered.slice(0, 30), null, 2));
  console.log('\nSaved top 30 to scripts/_chill-candidates.json');
}

main().catch(e => { console.error(e); process.exit(1); });
