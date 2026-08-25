# Harry Potter Meme Trailer — Streamer Phrase-Matching Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone scripts that let Claude search Twitch streamer clip transcripts for lines matching each scene of the Harry Potter trailer, memory-light (transcripts kept, videos deleted), stopping at a reviewed match list plus the downloaded winning clips — no video compositing.

**Architecture:** Four new/extended pieces reusing the existing DDOS Twitch/yt-dlp/Whisper infrastructure: (1) `lib/twitch-api.js` gains an all-time (no date-window) top-clips fetch, (2) `lib/download.js` exposes its existing single-URL downloader for the non-Twitch trailer source, (3) a new pure `lib/phrase-index.js` turns Whisper word-timestamps into searchable phrase segments and merges them into a resumable per-streamer index, (4) three new orchestration scripts (`trailer-prep.js`, `streamer-phrase-index.js`, `clip-fetch-selected.js`) wire these together into the TRAILER_PREP / CLIP_SOURCE / CLIP_FETCH stages from the design spec. CASTING and PHRASE_MATCH stay conversation-driven (Claude writes `casting.json`/`matches.json` directly per the design's "Claude scores in conversation" convention) — this plan does not build UI or scoring code for them, only the data contracts they must follow.

**Tech Stack:** Node.js (existing DDOS script conventions, no test framework — hand-rolled `assert`-based `.test.js` files run via `node`), Python/WhisperX (`scripts/transcribe-batch.py`, already GPU-verified), yt-dlp, Twitch Helix API.

---

## Data Contracts

These JSON shapes are produced by Claude directly in conversation (`casting.json`, `matches.json`, `trailer/scenes.json`) or by the scripts built in this plan (`trailer/transcript.json`, `candidates/<streamer>/phrases.json`). Every script below reads/writes exactly this shape — there is no separate schema file, these are the source of truth.

```
trailer/scenes.json          [{ sceneId: "01", character: "Harry", line: "...", startTime: 12.4, endTime: 14.1 }, ...]
casting.json                 [{ role: "Harry", streamer: "<twitch-login-lowercase>", tier: "main"|"secondary", clipPoolSize: 1000 }, ...]
candidates/<streamer>/
  phrases.json                [{ clipId, url, title, views, date: "YYYY-MM-DD",
                                  segments: [{ text, start, end }, ...] }, ...]
matches.json                 [{ sceneId: "01", role: "Harry", streamer: "<login>", clipId, quote,
                                 timestamp: { start: 4.2, end: 6.0 } }, ...]
selected/<NN>_<role>_<streamer>_<idSuffix>.mp4   (NN = 1-based position in matches.json, zero-padded)
```

`casting.json.streamer` MUST be the Twitch **login** (the lowercase username used in URLs), not the display name — `streamer-phrase-index.js` resolves it via `getUsersByLogin`, which only matches logins.

---

### Task 1: Expose `tryDownload` from `lib/download.js`

The trailer source is a YouTube URL, not a Twitch clip object, so it can't go through `downloadClip()` (which builds its filename from Twitch clip fields). The plain single-URL yt-dlp call it wraps, `tryDownload`, already exists but is private to the module — export it so `trailer-prep.js` (Task 6) can call it directly instead of duplicating the yt-dlp spawn logic.

**Files:**
- Modify: `scripts/lib/download.js:89`

- [ ] **Step 1: Add `tryDownload` to the exports**

Change line 89 from:
```js
module.exports = { buildFilename, isValidMp4, downloadClip, runParallel };
```
to:
```js
module.exports = { buildFilename, isValidMp4, downloadClip, runParallel, tryDownload };
```

- [ ] **Step 2: Verify the file still parses**

Run: `node --check scripts/lib/download.js`
Expected: no output, exit code 0

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/download.js
git commit -m "Export tryDownload from lib/download.js for non-Twitch single-URL downloads"
```

---

### Task 2: Add all-time top-clips fetch to `lib/twitch-api.js`

`fetchClipsForBroadcaster` (existing) always requires a `started_at` window — it's built for the main pipeline's 24h/N-hour ingest runs. The meme-trailer pool needs a streamer's top clips of **all time** (Twitch's Helix `GET /clips` returns clips sorted by view count descending when `started_at`/`ended_at` are omitted), up to a large N (≤1000 for main roles). Add a dedicated function rather than overloading the existing one with an optional/empty `startedAt`, which would silently produce a malformed `started_at=` query param.

**Files:**
- Modify: `scripts/lib/twitch-api.js:143` (insert before the `return { ... }` at the end of `createTwitchClient`)
- Modify: `scripts/lib/twitch-api.js:203-206` (exports)

- [ ] **Step 1: Add the paginated all-time fetch functions**

Insert after `fetchClipsForBroadcaster` (after line 143, before the `getGamesByIds` comment on line 145):

```js
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
```

- [ ] **Step 2: Export the new function**

Change the `return` block (was lines 203-206) from:
```js
  return {
    httpsGet, getTopGames, fetchClipsPage, fetchClipsForCategory, fetchVtuberBroadcasterIds, fetchVodCreatedTimes,
    getUsersByLogin, fetchClipsForBroadcaster, getGamesByIds,
  };
```
to:
```js
  return {
    httpsGet, getTopGames, fetchClipsPage, fetchClipsForCategory, fetchVtuberBroadcasterIds, fetchVodCreatedTimes,
    getUsersByLogin, fetchClipsForBroadcaster, getGamesByIds, fetchTopClipsForBroadcaster,
  };
```

- [ ] **Step 3: Verify the file still parses**

Run: `node --check scripts/lib/twitch-api.js`
Expected: no output, exit code 0

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/twitch-api.js
git commit -m "Add fetchTopClipsForBroadcaster for all-time top-N clip pools"
```

---

### Task 3: `lib/phrase-index.js` — failing tests first

Pure logic, no I/O — the only genuinely unit-testable piece of this plan (everything else is orchestration around network/ffmpeg/Whisper, matching the existing codebase's convention of only unit-testing `scripts/lib/*` pure functions, e.g. `select.js`/`timeline.js`/`profanity.js`).

**Files:**
- Test: `scripts/lib/phrase-index.test.js`

- [ ] **Step 1: Write the failing test file**

```js
'use strict';
const assert = require('assert');
const { wordsToSegments, buildPhraseEntry, mergePhraseEntries } = require('./phrase-index');

let failed = false;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failed = true; console.error(`  FAIL - ${name}\n    ${e.message}`); }
}

console.log('wordsToSegments');

test('groups consecutive words by seg index into {text,start,end}', () => {
  const words = [
    { word: 'hello', start: 0.0, end: 0.3, seg: 0 },
    { word: 'there', start: 0.3, end: 0.6, seg: 0 },
    { word: 'general', start: 1.0, end: 1.4, seg: 1 },
    { word: 'kenobi', start: 1.4, end: 1.9, seg: 1 },
  ];
  const segs = wordsToSegments(words);
  assert.strictEqual(segs.length, 2);
  assert.deepStrictEqual(segs[0], { text: 'hello there', start: 0.0, end: 0.6 });
  assert.deepStrictEqual(segs[1], { text: 'general kenobi', start: 1.0, end: 1.9 });
});

test('empty words returns empty segments', () => {
  assert.deepStrictEqual(wordsToSegments([]), []);
  assert.deepStrictEqual(wordsToSegments(undefined), []);
});

console.log('buildPhraseEntry');

test('builds entry from clip metadata + transcript', () => {
  const clip = { id: 'abc123', url: 'https://clips.twitch.tv/abc123', title: 'W Clip', view_count: 5000, created_at: '2026-05-15T10:00:00Z' };
  const transcript = {
    clip_id: 'abc123', text: 'hello there',
    words: [
      { word: 'hello', start: 0.0, end: 0.3, seg: 0 },
      { word: 'there', start: 0.3, end: 0.6, seg: 0 },
    ],
  };
  const entry = buildPhraseEntry(clip, transcript);
  assert.strictEqual(entry.clipId, 'abc123');
  assert.strictEqual(entry.url, 'https://clips.twitch.tv/abc123');
  assert.strictEqual(entry.views, 5000);
  assert.strictEqual(entry.date, '2026-05-15');
  assert.deepStrictEqual(entry.segments, [{ text: 'hello there', start: 0.0, end: 0.6 }]);
});

test('returns null for a failed transcription', () => {
  const clip = { id: 'x', url: 'u', title: 't', view_count: 1, created_at: '2026-01-01T00:00:00Z' };
  assert.strictEqual(buildPhraseEntry(clip, { clip_id: 'x', error: 'boom' }), null);
  assert.strictEqual(buildPhraseEntry(clip, null), null);
});

console.log('mergePhraseEntries');

test('dedupes by clipId, existing entries win', () => {
  const existing = [{ clipId: 'a', title: 'old' }];
  const merged = mergePhraseEntries(existing, [{ clipId: 'a', title: 'new' }, { clipId: 'b', title: 'fresh' }]);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged.find(e => e.clipId === 'a').title, 'old');
  assert.strictEqual(merged.find(e => e.clipId === 'b').title, 'fresh');
});

test('skips null entries from failed transcriptions', () => {
  const merged = mergePhraseEntries([], [null, { clipId: 'a' }, null]);
  assert.deepStrictEqual(merged, [{ clipId: 'a' }]);
});

console.log(failed ? '\nSome tests FAILED' : '\nAll tests passed');
if (failed) process.exit(1);
```

- [ ] **Step 2: Run it to confirm it fails (module doesn't exist yet)**

Run: `node scripts/lib/phrase-index.test.js`
Expected: `Error: Cannot find module './phrase-index'` (non-zero exit)

- [ ] **Step 3: Commit the failing test**

```bash
git add scripts/lib/phrase-index.test.js
git commit -m "Add failing tests for lib/phrase-index.js"
```

---

### Task 4: Implement `lib/phrase-index.js`

**Files:**
- Create: `scripts/lib/phrase-index.js`

- [ ] **Step 1: Write the implementation**

```js
'use strict';
// phrase-index.js — pure helpers for building/merging candidates/<streamer>/phrases.json
// from Whisper transcript output (scripts/transcribe-batch.py). No I/O here — callers
// (streamer-phrase-index.js) own file reads/writes so this stays unit-testable.

// transcribe-batch.py's output has word-level timestamps with a `seg` index
// linking each word back to its original Whisper segment, but no explicit
// segment-level {text, start, end} list. Rebuild one — phrase search matches
// against segment-length chunks, not individual words.
function wordsToSegments(words) {
  const segments = [];
  let current = null;
  for (const w of (words || [])) {
    if (!current || current.seg !== w.seg) {
      current = { seg: w.seg, start: w.start, end: w.end, words: [w.word] };
      segments.push(current);
    } else {
      current.end = w.end;
      current.words.push(w.word);
    }
  }
  return segments.map(s => ({ text: s.words.join(' ').trim(), start: s.start, end: s.end }));
}

// clipMeta: raw Twitch clip object (id, url, title, view_count, created_at).
// transcript: transcribe-batch.py output ({clip_id, text, words, error?}).
// Returns null for failed transcriptions — caller skips them rather than
// polluting the phrase index with empty entries.
function buildPhraseEntry(clipMeta, transcript) {
  if (!transcript || transcript.error) return null;
  return {
    clipId: clipMeta.id,
    url: clipMeta.url,
    title: clipMeta.title || '',
    views: clipMeta.view_count || 0,
    date: (clipMeta.created_at || '').slice(0, 10),
    segments: wordsToSegments(transcript.words),
  };
}

// Dedupe-merge by clipId, existing entries win (re-running never overwrites
// already-indexed clips — matches the "skip cached" pattern used across the
// rest of the pipeline, e.g. transcribe-batch.js).
function mergePhraseEntries(existing, newEntries) {
  const byId = new Map((existing || []).map(e => [e.clipId, e]));
  for (const entry of (newEntries || [])) {
    if (entry && !byId.has(entry.clipId)) byId.set(entry.clipId, entry);
  }
  return [...byId.values()];
}

module.exports = { wordsToSegments, buildPhraseEntry, mergePhraseEntries };
```

- [ ] **Step 2: Run the tests, confirm they pass**

Run: `node scripts/lib/phrase-index.test.js`
Expected:
```
wordsToSegments
  ok - groups consecutive words by seg index into {text,start,end}
  ok - empty words returns empty segments
buildPhraseEntry
  ok - builds entry from clip metadata + transcript
  ok - returns null for a failed transcription
mergePhraseEntries
  ok - dedupes by clipId, existing entries win
  ok - skips null entries from failed transcriptions

All tests passed
```

- [ ] **Step 3: Wire the test into `npm test`**

In `package.json`, change:
```json
"test": "node scripts/lib/select.test.js && node scripts/lib/timeline.test.js && node scripts/lib/profanity.test.js"
```
to:
```json
"test": "node scripts/lib/select.test.js && node scripts/lib/timeline.test.js && node scripts/lib/profanity.test.js && node scripts/lib/phrase-index.test.js"
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all four test files print `All tests passed` (or equivalent success output), exit code 0

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/phrase-index.js package.json
git commit -m "Implement lib/phrase-index.js and wire it into npm test"
```

---

### Task 5: `trailer-prep.js` — TRAILER_PREP stage

Downloads the trailer and transcribes it. Scene segmentation (`trailer/scenes.json`) is a judgment call Claude makes afterward in conversation, not by this script — it only produces the raw transcript that judgment call reads.

**Files:**
- Create: `scripts/trailer-prep.js`

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// DDOS Harry Potter meme-trailer — TRAILER_PREP
// Downloads the source trailer and transcribes it. Scene segmentation
// (trailer/scenes.json — character/line/timestamp per beat) is a judgment
// call made by Claude in conversation afterward, not by this script.
//
// Usage: node scripts/trailer-prep.js <runId> <youtubeUrl>
//
// Writes: <projectDir>/trailer/source.mp4
//         <projectDir>/trailer/transcript.json  (transcribe-batch.py output shape)

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tryDownload, isValidMp4 } = require('./lib/download');
const { getProjectDir } = require('./lib/project-path');
const { pythonBin } = require('./lib/sys');

const [,, runId, youtubeUrl] = process.argv;
if (!runId || !youtubeUrl) {
  console.error('Usage: node scripts/trailer-prep.js <runId> <youtubeUrl>');
  process.exit(1);
}

const PROJECT_DIR = getProjectDir(runId);
const TRAILER_DIR = path.join(PROJECT_DIR, 'trailer');
const SOURCE_PATH = path.join(TRAILER_DIR, 'source.mp4');
const TRANSCRIPT_PATH = path.join(TRAILER_DIR, 'transcript.json');
const TMP_DIR = path.join('tmp', 'harry-trailer');

async function downloadTrailer() {
  fs.mkdirSync(TRAILER_DIR, { recursive: true });

  if (fs.existsSync(SOURCE_PATH) && await isValidMp4(SOURCE_PATH)) {
    console.log('[TRAILER-PREP] source.mp4 already exists and is valid — skipping download');
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, 1500 * attempt));
    console.log(`[TRAILER-PREP] downloading (attempt ${attempt})...`);
    const result = await tryDownload(youtubeUrl, SOURCE_PATH);
    if (result.ok) return;
    console.warn(`[TRAILER-PREP] attempt ${attempt} failed: ${result.stderr}`);
  }
  throw new Error('Failed to download trailer after 3 attempts');
}

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

async function transcribeTrailer() {
  if (fs.existsSync(TRANSCRIPT_PATH)) {
    const existing = JSON.parse(fs.readFileSync(TRANSCRIPT_PATH, 'utf8'));
    if (!existing.error) {
      console.log('[TRAILER-PREP] transcript.json already exists — skipping transcription');
      return;
    }
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const jobsFile = path.join(TMP_DIR, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify([
    { video_path: SOURCE_PATH, output_path: TRANSCRIPT_PATH, clip_id: 'trailer' },
  ], null, 2));

  console.log('[TRAILER-PREP] transcribing...');
  await runTranscribeBatch(jobsFile);
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  const result = JSON.parse(fs.readFileSync(TRANSCRIPT_PATH, 'utf8'));
  if (result.error) throw new Error(`Transcription failed: ${result.error}`);
  console.log(`[TRAILER-PREP] transcribed: ${result.words.length} words, ${result.duration}s`);
}

async function main() {
  await downloadTrailer();
  await transcribeTrailer();
  console.log('[TRAILER-PREP] done — next: Claude segments trailer/transcript.json into trailer/scenes.json');
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check scripts/trailer-prep.js`
Expected: no output, exit code 0

- [ ] **Step 3: Verify the usage guard**

Run: `node scripts/trailer-prep.js`
Expected:
```
Usage: node scripts/trailer-prep.js <runId> <youtubeUrl>
```
(exit code 1; this is the only part of the script testable without a real download+GPU transcription — the rest is exercised end-to-end later, in conversation, once the real trailer URL is provided)

- [ ] **Step 4: Commit**

```bash
git add scripts/trailer-prep.js
git commit -m "Add trailer-prep.js — TRAILER_PREP download+transcribe stage"
```

---

### Task 6: `streamer-phrase-index.js` — CLIP_SOURCE stage

For each streamer in `casting.json`: fetch up to `clipPoolSize` all-time top clips, transcribe all of them in one WhisperX model load, keep only the text index, delete every downloaded video. Resumable — clips already present in an existing `phrases.json` are skipped on re-run.

**Files:**
- Create: `scripts/streamer-phrase-index.js`

- [ ] **Step 1: Write the script**

```js
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
  writeJsonAtomic(phrasesPath(login), merged);
  console.log(`[PHRASE-INDEX] ${login}: phrases.json now has ${merged.length} entries (+${newEntries.length})`);

  fs.rmSync(streamerTmpDir, { recursive: true, force: true });

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
    const result = await processStreamer(login, id, poolByLogin.get(login), twitch);
    summary.push(result);
  }

  console.log('\n[PHRASE-INDEX] Summary:');
  summary.forEach(s => console.log(`  ${s.login}: ${s.indexed} indexed (+${s.added} this run)`));
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check scripts/streamer-phrase-index.js`
Expected: no output, exit code 0

- [ ] **Step 3: Verify the usage guard**

Run: `node scripts/streamer-phrase-index.js`
Expected:
```
Usage: node scripts/streamer-phrase-index.js <runId> [--streamer <login>]
```
(exit code 1; live end-to-end run happens later, in conversation, once `casting.json` exists for the real project — that run needs live Twitch API + GPU Whisper, which this plan's steps can't fabricate)

- [ ] **Step 4: Commit**

```bash
git add scripts/streamer-phrase-index.js
git commit -m "Add streamer-phrase-index.js — CLIP_SOURCE fetch+transcribe+delete stage"
```

---

### Task 7: `clip-fetch-selected.js` — CLIP_FETCH stage

Downloads the one approved clip per `matches.json` entry into `selected/`. This is the only stage that leaves full video files in the project directory — everything upstream of the PHRASE_MATCH checkpoint only ever kept transcripts.

**Files:**
- Create: `scripts/clip-fetch-selected.js`

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// DDOS Harry Potter meme-trailer — CLIP_FETCH
// Downloads the ONE approved clip per matches.json entry — the only clips that
// ever get a full video file written to the project directory (candidates/'s
// phrases.json never keeps videos, see streamer-phrase-index.js).
//
// Usage: node scripts/clip-fetch-selected.js <runId>
//
// Reads:  <projectDir>/matches.json
//         [{sceneId, role, streamer, clipId, timestamp:{start,end}, quote}]
//         <projectDir>/candidates/<streamer>/phrases.json   (for clip url lookup)
// Writes: <projectDir>/selected/<NN>_<role>_<streamer>_<idSuffix>.mp4

'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonSafe } = require('./lib/state');
const { tryDownload, isValidMp4 } = require('./lib/download');
const { sanitizeStreamer, idSuffix } = require('./lib/clip-naming');
const { getProjectDir } = require('./lib/project-path');

const [,, runId] = process.argv;
if (!runId) { console.error('Usage: node scripts/clip-fetch-selected.js <runId>'); process.exit(1); }

const PROJECT_DIR = getProjectDir(runId);
const CANDIDATES_DIR = path.join(PROJECT_DIR, 'candidates');
const SELECTED_DIR = path.join(PROJECT_DIR, 'selected');

function findClipUrl(streamer, clipId) {
  const phrases = readJsonSafe(path.join(CANDIDATES_DIR, streamer, 'phrases.json'), []);
  const entry = phrases.find(p => p.clipId === clipId);
  return entry ? entry.url : null;
}

async function downloadOne(match, nn) {
  const url = findClipUrl(match.streamer, match.clipId);
  if (!url) {
    console.error(`  [MISSING] ${match.sceneId} (${match.role}/${match.streamer}): clipId ${match.clipId} not found in phrases.json`);
    return { match, status: 'missing-url' };
  }

  const basename = `${String(nn).padStart(2, '0')}_${sanitizeStreamer(match.role)}_${sanitizeStreamer(match.streamer)}_${idSuffix(match.clipId)}`;
  const outPath = path.join(SELECTED_DIR, `${basename}.mp4`);

  if (fs.existsSync(outPath) && await isValidMp4(outPath)) {
    console.log(`  [SKIP] ${basename}.mp4 already downloaded`);
    return { match, status: 'skipped', filename: `${basename}.mp4` };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, 1500 * attempt));
    const result = await tryDownload(url, outPath);
    if (result.ok) {
      console.log(`  [OK] ${basename}.mp4`);
      return { match, status: 'ok', filename: `${basename}.mp4` };
    }
    console.warn(`  [RETRY ${attempt}] ${basename}.mp4: ${result.stderr}`);
  }
  return { match, status: 'error' };
}

async function main() {
  const matches = readJsonSafe(path.join(PROJECT_DIR, 'matches.json'), []);
  if (!Array.isArray(matches) || matches.length === 0) {
    console.error('[CLIP-FETCH] matches.json is empty or missing — approve phrase matches first.');
    process.exit(1);
  }

  fs.mkdirSync(SELECTED_DIR, { recursive: true });
  console.log(`[CLIP-FETCH] ${matches.length} approved matches`);

  const results = [];
  for (let i = 0; i < matches.length; i++) {
    results.push(await downloadOne(matches[i], i + 1));
  }

  const ok = results.filter(r => r.status === 'ok' || r.status === 'skipped');
  const errors = results.filter(r => r.status !== 'ok' && r.status !== 'skipped');
  console.log(`\n[CLIP-FETCH] done: ${ok.length}/${matches.length} ready in selected/, ${errors.length} failed`);
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check scripts/clip-fetch-selected.js`
Expected: no output, exit code 0

- [ ] **Step 3: Verify the usage guard**

Run: `node scripts/clip-fetch-selected.js`
Expected:
```
Usage: node scripts/clip-fetch-selected.js <runId>
```
(exit code 1)

- [ ] **Step 4: Commit**

```bash
git add scripts/clip-fetch-selected.js
git commit -m "Add clip-fetch-selected.js — CLIP_FETCH stage for approved matches"
```

---

## Self-Review Notes

**Spec coverage:** TRAILER_PREP → Task 5. CASTING → conversation-driven per spec, contract documented in "Data Contracts" (no task; nothing to build). CLIP_SOURCE → Tasks 2, 3, 4, 6. PHRASE_MATCH → conversation-driven, reads the `phrases.json` Task 6 produces (no task; nothing to build). CLIP_FETCH → Task 7. Edge cases from the spec: fewer clips than tier (handled — `fetchTopClipsForBroadcaster` returns whatever Twitch has, `.slice(maxClips)` never pads), transcription failure (handled — `buildPhraseEntry` returns `null`, tested in Task 3), no good match / ambiguous scene (conversation-level per spec, not code).

**Type consistency checked:** `casting.json` field names (`role`, `streamer`, `tier`, `clipPoolSize`) match between the Data Contracts section and Task 6's reader. `matches.json` field names (`sceneId`, `role`, `streamer`, `clipId`, `timestamp`, `quote`) match between Data Contracts and Task 7's reader. `phrases.json` entry shape (`clipId`, `url`, `title`, `views`, `date`, `segments`) matches between Task 4's `buildPhraseEntry` output, Task 3's tests, and Task 7's `findClipUrl` lookup (`clipId`, `url`).

**No placeholders:** every task has complete, runnable code — nothing deferred to "later".
