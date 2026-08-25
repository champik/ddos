#!/usr/bin/env node
// DDOS Harry Potter meme-trailer — CLIP_SOURCE
// Fetches each casting.json streamer's top clips (all-time, no ingest window),
// transcribes them, and keeps ONLY a text index (candidates/<streamer>/phrases.json)
// — clip video files are deleted right after transcription so a 1000-clip pool
// never accumulates on disk. Re-running skips clips already present in
// phrases.json (matches the "cached skip" idiom used by transcribe-batch.js).
//
// Usage: node scripts/streamer-phrase-index.js <runId> [--streamer <login>]
//
// Reads:  <projectDir>/casting.json      [{role, streamer, tier, clipPoolSize}]
// Writes: <projectDir>/candidates/<streamer>/phrases.json
//         [{clipId, url, title, views, date, segments:[{text,start,end}]}]

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readJsonSafe, writeJsonAtomic } = require('./lib/state');
const { downloadClip, runParallel } = require('./lib/download');
const { createTwitchClient, fetchAppAccessToken } = require('./lib/twitch-api');
const { buildPhraseEntry, mergePhraseEntries } = require('./lib/phrase-index');
const { getProjectDir } = require('./lib/project-path');
const { pythonBin } = require('./lib/sys');
require('./lib/env').loadEnv();

const [,, runId, ...rest] = process.argv;
if (!runId) { console.error('Usage: node scripts/streamer-phrase-index.js <runId> [--streamer <login>]'); process.exit(1); }

const streamerFlagIdx = rest.indexOf('--streamer');
const ONLY_STREAMER = streamerFlagIdx >= 0 ? rest[streamerFlagIdx + 1].toLowerCase() : null;

const PROJECT_DIR = getProjectDir(runId);
const CANDIDATES_DIR = path.join(PROJECT_DIR, 'candidates');
const TMP_DIR = path.join('tmp', 'harry-clips');
const MAX_PARALLEL = 5;

function phrasesPath(login) { return path.join(CANDIDATES_DIR, login, 'phrases.json'); }

function runTranscribeBatch(jobsFile) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin(), ['scripts/transcribe-batch.py', jobsFile], {
      cwd: path.join(__dirname, '..'),
    });
    let buf = '';
    const pump = chunk => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop();
      parts.forEach(line => process.stdout.write('  ' + line + '\n'));
    };
    proc.stdout.on('data', pump);
    proc.stderr.on('data', pump);
    proc.on('close', code => {
      if (buf.trim()) process.stdout.write('  ' + buf.trim() + '\n');
      code === 0 ? resolve() : reject(new Error(`transcribe-batch.py exited ${code}`));
    });
    proc.on('error', reject);
  });
}

async function processStreamer(login, broadcasterId, poolSize, twitch) {
  console.log(`\n[PHRASE-INDEX] ${login}: fetching up to ${poolSize} clips...`);
  const clips = await twitch.fetchTopClipsForBroadcaster(broadcasterId, poolSize);
  console.log(`[PHRASE-INDEX] ${login}: ${clips.length} clips returned by Twitch`);

  const existing = readJsonSafe(phrasesPath(login), []);
  const alreadyIndexed = new Set(existing.map(e => e.clipId));
  const todo = clips.filter(c => !alreadyIndexed.has(c.id));
  console.log(`[PHRASE-INDEX] ${login}: ${todo.length} new, ${clips.length - todo.length} already indexed`);

  if (todo.length === 0) return { login, indexed: existing.length, added: 0 };

  const streamerTmpDir = path.join(TMP_DIR, login);
  fs.mkdirSync(streamerTmpDir, { recursive: true });

  const tasks = todo.map((clip, i) => () => {
    process.stdout.write(`\r  download ${i + 1}/${todo.length} ...`);
    return downloadClip(clip, streamerTmpDir);
  });
  const dlResults = await runParallel(tasks, MAX_PARALLEL);
  console.log('');

  const dlOk = dlResults.filter(r => r.status === 'ok' || r.status === 'skipped');
  const dlErrors = dlResults.filter(r => r.status === 'error');
  console.log(`[PHRASE-INDEX] ${login}: downloaded ${dlOk.length}, failed ${dlErrors.length}`);

  const jobs = dlOk.map(r => ({
    video_path: path.join(streamerTmpDir, r.filename),
    output_path: path.join(streamerTmpDir, r.filename.replace(/\.mp4$/, '.json')),
    clip_id: r.clip.id,
  }));

  if (jobs.length > 0) {
    const jobsFile = path.join(streamerTmpDir, '_jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
    console.log(`[PHRASE-INDEX] ${login}: transcribing ${jobs.length} clips (one model load)...`);
    await runTranscribeBatch(jobsFile);
  }

  const newEntries = [];
  for (const r of dlOk) {
    const transcriptPath = path.join(streamerTmpDir, r.filename.replace(/\.mp4$/, '.json'));
    const transcript = readJsonSafe(transcriptPath, null);
    const entry = buildPhraseEntry(r.clip, transcript);
    if (entry) newEntries.push(entry);
  }

  const merged = mergePhraseEntries(existing, newEntries);
  fs.mkdirSync(path.dirname(phrasesPath(login)), { recursive: true });
  try {
    writeJsonAtomic(phrasesPath(login), merged);
    console.log(`[PHRASE-INDEX] ${login}: phrases.json now has ${merged.length} entries (+${newEntries.length})`);
  } finally {
    fs.rmSync(streamerTmpDir, { recursive: true, force: true });
  }

  return { login, indexed: merged.length, added: newEntries.length };
}

async function main() {
  const casting = readJsonSafe(path.join(PROJECT_DIR, 'casting.json'), []);
  if (!Array.isArray(casting) || casting.length === 0) {
    console.error('[PHRASE-INDEX] casting.json is empty or missing — approve casting first.');
    process.exit(1);
  }

  // One streamer is cast in only one role per the design, but dedupe by login
  // defensively and take the largest requested pool if it ever isn't.
  const poolByLogin = new Map();
  for (const c of casting) {
    const login = c.streamer.toLowerCase();
    poolByLogin.set(login, Math.max(poolByLogin.get(login) || 0, c.clipPoolSize));
  }

  const logins = ONLY_STREAMER ? [ONLY_STREAMER] : [...poolByLogin.keys()];
  if (ONLY_STREAMER && !poolByLogin.has(ONLY_STREAMER)) {
    console.error(`[PHRASE-INDEX] --streamer ${ONLY_STREAMER} not found in casting.json`);
    process.exit(1);
  }

  const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
  const TOKEN = process.env.TWITCH_TOKEN || await fetchAppAccessToken(CLIENT_ID, process.env.TWITCH_CLIENT_SECRET);
  const twitch = createTwitchClient(CLIENT_ID, TOKEN);

  const idMap = await twitch.getUsersByLogin(logins);
  const missing = logins.filter(l => !idMap.has(l));
  if (missing.length) console.warn(`[PHRASE-INDEX] [WARN] Unknown Twitch login(s), skipped: ${missing.join(', ')}`);

  const summary = [];
  for (const login of logins) {
    const id = idMap.get(login);
    if (!id) continue;
    try {
      const result = await processStreamer(login, id, poolByLogin.get(login), twitch);
      summary.push(result);
    } catch (e) {
      console.error(`[PHRASE-INDEX] ${login}: FAILED — ${e.message}`);
      summary.push({ login, error: e.message });
    }
  }

  console.log('\n[PHRASE-INDEX] Summary:');
  summary.forEach(s => console.log(
    s.error ? `  ${s.login}: FAILED — ${s.error}` : `  ${s.login}: ${s.indexed} indexed (+${s.added} this run)`
  ));
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
