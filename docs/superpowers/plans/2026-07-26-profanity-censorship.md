# Profanity Censorship Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Tier 1+2 profanity from existing word-level transcripts, mute it in `clean.mp4` with a `glitch.wav` overlay (feeding both the long-form episode and shorts, since both read `clean.mp4`), mask the same words in shorts captions, and let the editor add manual mute marks in `edit.html` for anything the detector misses.

**Architecture:** New `scripts/lib/profanity.js` is the single word-list source of truth. New `scripts/apply-censor.js` runs as stage **8b**, between TRANSCRIBE and OVERLAYS, and overwrites `clean.mp4` in place — no downstream script (`apply-overlays.js`, `build-concat.js`, `render-shorts.js`) needs to change, they already just read whatever audio is in `clean.mp4`. `scripts/stage2.js`'s parallel chains must be restructured because OVERLAYS currently starts before TRANSCRIBE finishes; it now has to wait for CENSOR too. `gen-captions.js` masks the same words in ASS captions and drops the unrelated `HOT` emphasis list. `edit.html` gets a `🔇 Mute` action button (always adds a mark, unlike the toggle-style Recon/Thumb/Short/VOD buttons) and the `CC` button is relabeled `VOD`. `gen-review.js` surfaces censored words in the existing Tags column.

**Tech Stack:** Node.js (no test framework — plain `assert`-based custom runner, see `scripts/lib/select.test.js`), ffmpeg/ffprobe via `child_process.spawn`.

**Spec:** `docs/superpowers/specs/2026-07-26-profanity-censorship-design.md`

---

### Task 1: `scripts/lib/profanity.js` — word list + matching + masking

**Files:**
- Create: `scripts/lib/profanity.js`
- Test: `scripts/lib/profanity.test.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/profanity.test.js`:

```js
'use strict';
const assert = require('assert');
const { normalizeWord, isProfane, maskWord } = require('./profanity');

let failed = false;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failed = true; console.error(`  FAIL - ${name}\n    ${e.message}`); }
}

console.log('normalizeWord');

test('lowercases and strips punctuation', () => {
  assert.strictEqual(normalizeWord('Shit!'), 'shit');
  assert.strictEqual(normalizeWord('  Fuck,'), 'fuck');
});

test('keeps apostrophes', () => {
  assert.strictEqual(normalizeWord("Y'all"), "y'all");
});

console.log('isProfane');

test('matches Tier 1 words', () => {
  assert.strictEqual(isProfane('fuck'), true);
  assert.strictEqual(isProfane('Fucking'), true);
  assert.strictEqual(isProfane('shit.'), true);
  assert.strictEqual(isProfane('bitch,'), true);
});

test('matches Tier 2 slurs', () => {
  assert.strictEqual(isProfane('nigga'), true);
  assert.strictEqual(isProfane('faggot'), true);
  assert.strictEqual(isProfane('retarded'), true);
});

test('does not match mild Tier 3 words (excluded by design)', () => {
  assert.strictEqual(isProfane('damn'), false);
  assert.strictEqual(isProfane('hell'), false);
  assert.strictEqual(isProfane('crap'), false);
});

test('does not substring-match inside innocent words', () => {
  assert.strictEqual(isProfane('assume'), false);
  assert.strictEqual(isProfane('class'), false);
  assert.strictEqual(isProfane('assist'), false);
  assert.strictEqual(isProfane('grass'), false);
});

test('everyday words are not flagged', () => {
  assert.strictEqual(isProfane('hello'), false);
  assert.strictEqual(isProfane('the'), false);
});

console.log('maskWord');

test('keeps first/last letter, masks the middle', () => {
  assert.strictEqual(maskWord('fuck'), 'f**k');
  assert.strictEqual(maskWord('shit'), 's**t');
  assert.strictEqual(maskWord('bitch'), 'b***h');
  assert.strictEqual(maskWord('ass'), 'a*s');
});

test('preserves original casing and trailing punctuation', () => {
  assert.strictEqual(maskWord('Fuck,'), 'F**k,');
  assert.strictEqual(maskWord('SHIT!'), 'S**T!');
});

test('leaves 2-letter-or-shorter tokens untouched (no profanity word is this short, but must not crash)', () => {
  assert.strictEqual(maskWord('hi'), 'hi');
  assert.strictEqual(maskWord('a'), 'a');
});

if (failed) {
  console.error('\nPROFANITY TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nAll profanity.test.js checks passed.');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/profanity.test.js`
Expected: `Error: Cannot find module './profanity'` (or similar) — the module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/profanity.js`:

```js
'use strict';
// profanity.js — single source of truth for profanity detection + masking.
// Used by scripts/apply-censor.js (audio mute) and scripts/gen-captions.js
// (caption text masking) so the two never drift out of sync.
//
// Tier 1 (hard profanity) + Tier 2 (slurs) only — mild words (damn/hell/crap)
// are deliberately excluded: by themselves they rarely trigger YouTube
// demonetization, and muting them on every use would make videos feel
// choppy without cause. See docs/superpowers/specs/2026-07-26-profanity-censorship-design.md.

const TIER1 = [
  'fuck', 'fucking', 'fucked', 'fucker', 'fuckers', 'motherfucker', 'motherfucking',
  'fuk', 'fck', 'shit', 'shitty', 'bullshit', 'horseshit', 'cunt', 'cunts',
  'dick', 'dicks', 'pussy', 'whore', 'whores', 'slut', 'sluts', 'cum',
  'asshole', 'assholes', 'bitch', 'bitches', 'bitchy', 'bastard', 'bastards',
  'cock', 'cocks',
];

const TIER2 = [
  'nigger', 'nigga', 'niggas', 'faggot', 'fag', 'faggots', 'retard', 'retarded',
  'tranny', 'chink', 'spic', 'gook', 'kike',
];

const PROFANITY_WORDS = new Set([...TIER1, ...TIER2]);

function normalizeWord(w) {
  return String(w || '').trim().toLowerCase().replace(/[^a-z']/g, '');
}

function isProfane(word) {
  return PROFANITY_WORDS.has(normalizeWord(word));
}

// Keeps the letters at both ends, masks everything between with '*'.
// Operates on the original token so surrounding punctuation ("shit,") and
// casing ("SHIT") are preserved — only the letter run itself gets masked.
function maskWord(rawWord) {
  const str = String(rawWord || '');
  const m = str.match(/^([^a-zA-Z']*)([a-zA-Z']+)([^a-zA-Z']*)$/);
  if (!m) return str;
  const [, lead, letters, trail] = m;
  if (letters.length <= 2) return str;
  const masked = letters[0] + '*'.repeat(letters.length - 2) + letters[letters.length - 1];
  return lead + masked + trail;
}

module.exports = { PROFANITY_WORDS, normalizeWord, isProfane, maskWord };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/lib/profanity.test.js`
Expected: all `ok -` lines, ending with `All profanity.test.js checks passed.`

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/profanity.js scripts/lib/profanity.test.js
git commit -m "Add profanity word list, matching, and caption masking helper"
```

---

### Task 2: Wire `profanity.test.js` into `npm test`

**Files:**
- Modify: `package.json:3`

- [ ] **Step 1: Update the test script**

Current:
```json
    "test": "node scripts/lib/select.test.js && node scripts/lib/timeline.test.js"
```

New:
```json
    "test": "node scripts/lib/select.test.js && node scripts/lib/timeline.test.js && node scripts/lib/profanity.test.js"
```

- [ ] **Step 2: Run to verify**

Run: `npm test`
Expected: all three test files run, all pass.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "Run profanity.test.js as part of npm test"
```

---

### Task 3: `scripts/apply-censor.js` — mute profanity + overlay glitch.wav

**Files:**
- Create: `scripts/apply-censor.js`

This mirrors the structure of `scripts/apply-editorial.js` (worker-pool concurrency, per-clip hash-based caching) and `scripts/apply-overlays.js` (reads `processed/<clipId>/clean.mp4`, writes back into `processed/<clipId>/`).

- [ ] **Step 1: Write the script**

Create `scripts/apply-censor.js`:

```js
#!/usr/bin/env node
'use strict';
// apply-censor.js <projectDir>
// Mutes Tier 1/2 profanity (auto-detected from transcript.json word timestamps,
// plus editor-added manualMutes from editorial.json) in processed/<clipId>/clean.mp4,
// overlaying assets/sounds/glitch.wav in the gap. Overwrites clean.mp4 in place so
// every downstream stage (overlays, build-concat, render-shorts) inherits the
// censored audio without any changes on their end.
//
// See docs/superpowers/specs/2026-07-26-profanity-censorship-design.md

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');
const { readJson, readJsonSafe, updateState, stageStatus } = require('./lib/state');
const { getDurationAsync } = require('./lib/media-probe');
const { normalizeWord, isProfane, maskWord } = require('./lib/profanity');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node scripts/apply-censor.js <projectDir>'); process.exit(1); }

require('./progress').step(projectDir, '8b', 'Цензура матюків');

const GLITCH_PATH = path.resolve('assets/sounds/glitch.wav');
const PAD = 0.04; // secs of extra mute on each side of a detected word, clamped to neighbors

const editorialPath = path.join(projectDir, 'edit', 'editorial.json');
const editorial = readJson(editorialPath);
const editorialClips = editorial.clips || {};

const CONCURRENCY = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));

function ffmpegAsync(args) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => resolve({ status: code, stderr }));
    proc.on('error', e => resolve({ status: -1, stderr: e.message }));
  });
}

// Builds the list of [start,end] mute windows for one clip: auto-detected
// profane words (padded, clamped so they never bleed into a neighboring
// word) plus any editor-added manual marks (fixed length = glitch duration).
function buildMuteWindows(words, manualMutes, clipDuration, glitchDuration) {
  const hits = [];
  (words || []).forEach((w, i) => {
    if (!isProfane(normalizeWord(w.word))) return;
    const prevEnd = i > 0 ? words[i - 1].end : 0;
    const nextStart = i < words.length - 1 ? words[i + 1].start : clipDuration;
    const start = Math.max(prevEnd, w.start - PAD);
    const end = Math.min(nextStart, w.end + PAD);
    if (end <= start) return;
    hits.push({ word: w.word, masked: maskWord(w.word), start, end, source: 'auto' });
  });
  (manualMutes || []).forEach(m => {
    const start = Math.max(0, m.at);
    const end = Math.min(clipDuration, m.at + glitchDuration);
    if (end <= start) return;
    hits.push({ word: null, masked: null, start, end, source: 'manual' });
  });
  hits.sort((a, b) => a.start - b.start);
  return hits;
}

function windowsHash(windows) {
  const src = JSON.stringify(windows.map(w => [w.start, w.end, w.source]));
  return crypto.createHash('md5').update(src).digest('hex');
}

// One ffmpeg pass: mute the original audio during every window, and mix in
// glitch.wav (trimmed to each window's own duration, so it never bleeds past
// the muted word into the next one) at the same offsets. Video is untouched.
async function censorAudio(cleanPath, tmpPath, windows) {
  const muteExpr = windows.map(w => `between(t,${w.start.toFixed(3)},${w.end.toFixed(3)})`).join('+');
  const filterParts = [`[0:a]volume=0:enable='${muteExpr}'[muted]`];
  const asplitLabels = windows.map((_, i) => `[gin${i}]`).join('');
  filterParts.push(`[1:a]asplit=${windows.length}${asplitLabels}`);
  windows.forEach((w, i) => {
    const durMs = ((w.end - w.start) * 1000).toFixed(0);
    const delayMs = (w.start * 1000).toFixed(0);
    filterParts.push(`[gin${i}]atrim=0:${(w.end - w.start).toFixed(3)},adelay=${delayMs}|${delayMs}[g${i}]`);
  });
  const mixInputs = ['[muted]', ...windows.map((_, i) => `[g${i}]`)].join('');
  filterParts.push(`${mixInputs}amix=inputs=${windows.length + 1}:duration=first:dropout_transition=0:normalize=0[outa]`);

  const args = [
    '-i', cleanPath,
    '-i', GLITCH_PATH,
    '-filter_complex', filterParts.join(';'),
    '-map', '0:v', '-map', '[outa]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-y', tmpPath,
  ];
  const result = await ffmpegAsync(args);
  if (result.status !== 0) {
    const lines = (result.stderr || '').split('\n').filter(l => /error/i.test(l));
    if (lines.length) console.error('  FFmpeg:\n  ' + lines.slice(0, 3).join('\n  '));
  }
  return result.status === 0;
}

let processed = 0, skipped = 0, failed = 0;

async function censorClip(clipId) {
  const outDir = path.join(projectDir, 'processed', clipId);
  const cleanPath = path.join(outDir, 'clean.mp4');
  const hashPath = path.join(outDir, 'censor-hash.txt');
  const logPath = path.join(outDir, 'censor-log.json');

  if (!fs.existsSync(cleanPath)) { console.warn('SKIP (no clean.mp4):', clipId); skipped++; return; }

  const transcriptPath = path.join(outDir, 'transcript.json');
  const transcript = readJsonSafe(transcriptPath, null);
  const words = transcript?.words || [];
  const manualMutes = editorialClips[clipId]?.manualMutes || [];

  const clipDuration = await getDurationAsync(cleanPath);
  const glitchDuration = await getDurationAsync(GLITCH_PATH);

  const windows = buildMuteWindows(words, manualMutes, clipDuration, glitchDuration);
  const currentHash = windowsHash(windows);
  const cachedHash = fs.existsSync(hashPath) ? fs.readFileSync(hashPath, 'utf8').trim() : null;

  if (cachedHash === currentHash && fs.existsSync(logPath)) {
    console.log('CACHED:', clipId, `(${windows.length} mute windows)`);
    skipped++;
    return;
  }

  if (windows.length === 0) {
    fs.writeFileSync(logPath, JSON.stringify([], null, 2));
    fs.writeFileSync(hashPath, currentHash, 'utf8');
    console.log('CLEAN (no profanity):', clipId);
    skipped++;
    return;
  }

  const tmpPath = path.join(outDir, 'clean.censor-tmp.mp4');
  console.log(`CENSOR: ${clipId} — ${windows.length} window(s): ${windows.map(w => w.word || 'manual').join(', ')}`);
  const ok = await censorAudio(cleanPath, tmpPath, windows);

  if (!ok) {
    fs.rmSync(tmpPath, { force: true });
    console.error('FAILED:', clipId);
    failed++;
    return;
  }

  fs.renameSync(tmpPath, cleanPath);
  fs.writeFileSync(logPath, JSON.stringify(
    windows.map(w => ({ word: w.word, masked: w.masked, start: +w.start.toFixed(2), end: +w.end.toFixed(2), source: w.source })),
    null, 2
  ));
  fs.writeFileSync(hashPath, currentHash, 'utf8');
  console.log('OK:', clipId);
  processed++;
}

async function main() {
  const clipIds = (editorial.clipOrder || []).filter(id => !String(id).startsWith('__recon'));
  console.log(`\n=== apply-censor.js — ${projectDir} (${clipIds.length} clips, concurrency: ${CONCURRENCY}) ===\n`);

  let i = 0;
  async function worker() {
    while (i < clipIds.length) {
      await censorClip(clipIds[i++]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, clipIds.length) }, worker));

  console.log(`\nDone: ${processed} censored, ${skipped} skipped, ${failed} failed`);

  updateState(projectDir, s => {
    s.stages = s.stages || {};
    s.stages.censor = stageStatus(processed + skipped, failed);
  });

  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
```

- [ ] **Step 2: Sanity-check the module loads and windows math is correct**

Run:
```bash
node -e "
const { buildMuteWindows } = (() => {
  const mod = require('./scripts/apply-censor.js');
  return mod;
})();
"
```
Expected: this will actually throw, because `apply-censor.js` doesn't export anything (it's a CLI entrypoint, like `apply-editorial.js`) — that's correct and expected, don't add an export for this alone. Instead sanity-check by running it against a real project directory that already has `clean.mp4` + `transcript.json` (see Step 3).

- [ ] **Step 3: Manual end-to-end verification against a real clip**

Pick any existing project with completed TRANSCRIBE output, e.g.:
```bash
node scripts/apply-censor.js "projects/2026_07_July/Episode_49_2026_07_24"
```
Expected console output: one `CENSOR:`/`CLEAN (no profanity):` line per clip, ending in `Done: N censored, M skipped, 0 failed`.

Then verify one clip that got censored:
```bash
CLIP_ID=<a clipId printed above with CENSOR:>
cat "projects/2026_07_July/Episode_49_2026_07_24/processed/$CLIP_ID/censor-log.json"
ffmpeg -i "projects/2026_07_July/Episode_49_2026_07_24/processed/$CLIP_ID/clean.mp4" -af silencedetect=noise=-50dB:d=0.05 -f null - 2>&1 | grep -i silence
```
Expected: `censor-log.json` lists the word/timestamp; listening to the clip around that timestamp (or the silencedetect output) confirms the word is gone and replaced by the glitch sound, not dead silence.

- [ ] **Step 4: Re-run to verify caching**

Run the same command from Step 3 again.
Expected: every clip now prints `CACHED: ... (N mute windows)` — no re-encoding.

- [ ] **Step 5: Commit**

```bash
git add scripts/apply-censor.js
git commit -m "Add apply-censor.js: mute profanity in clean.mp4 with glitch.wav overlay"
```

---

### Task 4: `scripts/stage2.js` — insert CENSOR, fix chain ordering

**Files:**
- Modify: `scripts/stage2.js:58-67`

**Why this isn't just "add one line":** today `chainB` (`fetch-avatars → apply-overlays → build-concat → render-final`) starts in parallel with `chainA` (`transcribe-batch → gen-captions`), right after VOD replace. `apply-overlays.js` reads `processed/<clipId>/clean.mp4`. CENSOR must finish writing the censored `clean.mp4` *before* `apply-overlays.js` reads it — so OVERLAYS can no longer start before TRANSCRIBE finishes. `extract-frames.js` (`chainC`) is unaffected: censoring only touches the audio stream (`-c:v copy`), so frame extraction doesn't need to wait.

Current (`scripts/stage2.js:58-69`):
```js
  // ── PARALLEL: three independent chains ────────────────────────────────────
  const chainA = run('scripts/transcribe-batch.js', [runId])
    .then(() => run('scripts/gen-captions.js', [projectDir]));

  const chainB = run('scripts/fetch-avatars.js', [projectDir])
    .then(() => run('scripts/apply-overlays.js', [projectDir]))
    .then(() => run('scripts/build-concat.js', [runId]))
    .then(() => run('scripts/render-final.js', [projectDir, epNum]));

  const chainC = run('scripts/extract-frames.js', [projectDir]);

  const results = await Promise.allSettled([chainA, chainB, chainC]);

  const labels = ['TRANSCRIBE→CAPTIONS', 'FETCH_AVATARS→OVERLAYS→RENDER_LONG', 'EXTRACT_FRAMES'];
```

New:
```js
  // ── SERIAL: TRANSCRIBE → CENSOR gate everything downstream that reads
  // clean.mp4's audio (OVERLAYS) or its transcript (CAPTIONS). EXTRACT_FRAMES
  // only touches video frames, so it stays fully independent below.
  await run('scripts/transcribe-batch.js', [runId]);
  await run('scripts/apply-censor.js', [projectDir]);

  // ── PARALLEL: two independent chains (both gated on CENSOR above) ─────────
  const chainA = run('scripts/gen-captions.js', [projectDir]);

  const chainB = run('scripts/fetch-avatars.js', [projectDir])
    .then(() => run('scripts/apply-overlays.js', [projectDir]))
    .then(() => run('scripts/build-concat.js', [runId]))
    .then(() => run('scripts/render-final.js', [projectDir, epNum]));

  const chainC = run('scripts/extract-frames.js', [projectDir]);

  const results = await Promise.allSettled([chainA, chainB, chainC]);

  const labels = ['CAPTIONS', 'FETCH_AVATARS→OVERLAYS→RENDER_LONG', 'EXTRACT_FRAMES'];
```

- [ ] **Step 1: Apply the edit above** to `scripts/stage2.js`.

- [ ] **Step 2: Update the file's top-of-file dependency-graph comment**

Current (`scripts/stage2.js:5-9`):
```js
// Dependency graph after APPLY_EDITORIAL (clean.mp4 ready):
//   A: TRANSCRIBE → CAPTIONS               (CPU/GPU, then CPU)
//   B: OVERLAYS → BUILD_CONCAT → RENDER_LONG  (CPU, then I/O, then I/O)
//   C: EXTRACT_FRAMES                       (CPU, fully independent)
//
// A, B, C run in parallel. METADATA and beyond (RENDER_SHORTS, THUMBNAIL, REVIEW)
```

New:
```js
// Dependency graph after APPLY_EDITORIAL (clean.mp4 ready):
//   TRANSCRIBE → CENSOR (serial — CENSOR rewrites clean.mp4's audio in place,
//                so everything below must wait for it)
//   A: CAPTIONS                             (CPU)
//   B: OVERLAYS → BUILD_CONCAT → RENDER_LONG  (CPU, then I/O, then I/O)
//   C: EXTRACT_FRAMES                       (CPU, independent — video-only, doesn't need CENSOR)
//
// A, B, C run in parallel after CENSOR. METADATA and beyond (RENDER_SHORTS, THUMBNAIL, REVIEW)
```

- [ ] **Step 3: Verify no syntax errors**

Run: `node -c scripts/stage2.js`
Expected: no output (exit code 0).

- [ ] **Step 4: Commit**

```bash
git add scripts/stage2.js
git commit -m "Insert CENSOR stage between TRANSCRIBE and OVERLAYS in stage2.js"
```

---

### Task 5: `scripts/gen-captions.js` — remove HOT list, mask profanity

**Files:**
- Modify: `scripts/gen-captions.js:14-44,110-133`

- [ ] **Step 1: Import the profanity helper and delete the HOT list**

Current (`scripts/gen-captions.js:14-30`):
```js
const { readJson, updateState } = require('./lib/state');
const { analyzeRms, loudThreshold, isLoudAt, isProminentAt } = require('./lib/audio-peaks');
const plan = readJson(path.join(projectDir, 'edit/episode-plan.json'));

let editorialClips = {};
let editorialShortsArray = null;
try {
  const ed = readJson(path.join(projectDir, 'edit/editorial.json'));
  editorialClips = ed.clips || {};
  if (ed.shorts && ed.shorts.length > 0) editorialShortsArray = ed.shorts;
} catch {}


const HOT = new Set(['no','what','wait','stop','wtf','omg','insane','crazy',
  'holy','hell','wow','damn','bruh','nah',
  'fuck','fucking','fucked','shit','bitch','ass','crap','goddamn']);
```

New:
```js
const { readJson, updateState } = require('./lib/state');
const { analyzeRms, loudThreshold, isLoudAt, isProminentAt } = require('./lib/audio-peaks');
const { normalizeWord, isProfane, maskWord } = require('./lib/profanity');
const plan = readJson(path.join(projectDir, 'edit/episode-plan.json'));

let editorialClips = {};
let editorialShortsArray = null;
try {
  const ed = readJson(path.join(projectDir, 'edit/editorial.json'));
  editorialClips = ed.clips || {};
  if (ed.shorts && ed.shorts.length > 0) editorialShortsArray = ed.shorts;
} catch {}
```

- [ ] **Step 2: Remove `isHot()` (no longer used) and its only caller**

Current (`scripts/gen-captions.js:43-44`, right after the `HOT` set removed above):
```js
function isHot(word) { return HOT.has(word.replace(/[^a-z]/g, '').toLowerCase()); }
function isFn(word)  { return FUNCTION_WORDS.has(word.replace(/[^a-z]/g, '').toLowerCase()); }
```

New (drop the `isHot` line — `isFn` is still used by `groupIntoPhrases`):
```js
function isFn(word)  { return FUNCTION_WORDS.has(word.replace(/[^a-z]/g, '').toLowerCase()); }
```

Confirm `isHot` has no other callers: `grep -n "isHot" scripts/gen-captions.js` should now return nothing.

- [ ] **Step 3: Mask profane words in `buildKaraokeText()`**

Current (`scripts/gen-captions.js:110-133`):
```js
function buildKaraokeText(phraseWords, currentIdx, pop, phraseLoud) {
  const parts = [];
  if (pop) parts.push(pop);

  for (let j = 0; j < phraseWords.length; j++) {
    const loud = phraseLoud && phraseLoud[j];
    const text = loud
      ? phraseWords[j].word.trim().toUpperCase()
      : phraseWords[j].word.trim().toLowerCase();

    if (j === currentIdx) {
```

New:
```js
function buildKaraokeText(phraseWords, currentIdx, pop, phraseLoud) {
  const parts = [];
  if (pop) parts.push(pop);

  for (let j = 0; j < phraseWords.length; j++) {
    const loud = phraseLoud && phraseLoud[j];
    const raw = phraseWords[j].word.trim();
    const text = isProfane(normalizeWord(raw))
      ? maskWord(raw)
      : (loud ? raw.toUpperCase() : raw.toLowerCase());

    if (j === currentIdx) {
```

(Masked words keep their original casing from `maskWord` — they deliberately skip the loud-word UPPERCASE transform, since `f**k` uppercased is indistinguishable from lowercase; the scale-pop animation triggered by `pop` still applies independently, since that's computed from `phraseLoud[i]` before this function is called, not from the text itself.)

- [ ] **Step 4: Run existing tests to make sure nothing else broke**

Run: `npm test`
Expected: all pass (this file has no dedicated test suite — `select.test.js`/`timeline.test.js`/`profanity.test.js` are unrelated but must still pass, confirming no accidental syntax breakage elsewhere).

Run: `node -c scripts/gen-captions.js`
Expected: no output (exit code 0).

- [ ] **Step 5: Manual verification against a real project**

```bash
node scripts/gen-captions.js "projects/2026_07_July/Episode_49_2026_07_24"
```
Expected: runs to completion (`[DONE] Generated N shorts captions`). Then grep one output file for a masked word if that episode had any profanity in a short's transcript:
```bash
grep -o '[a-z]\*\+[a-z]' "projects/2026_07_July/Episode_49_2026_07_24/processed/<clipId>/captions-vertical.ass"
```

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-captions.js
git commit -m "Mask profanity in shorts captions, remove unrelated HOT emphasis list"
```

---

### Task 6: `edit.html` — Mute button, CC→VOD rename, manual mute marks

**Files:**
- Modify: `projects/Edit/edit/edit.html` (CSS ~L178, button row ~L3002-3011, `updateTimingExtras` ~L2898-2912, `toggleTag`/new functions ~L2742-2786, `buildJSON` ~L4160-4171)

- [ ] **Step 1: Add CSS for the new Mute button**

Current (`projects/Edit/edit/edit.html:178-179`):
```css
.ctrl-btn.tag-subtitle{color:#22d3ee55;border-color:#22d3ee22}
.ctrl-btn.tag-subtitle.on{color:#22d3ee;border-color:#22d3ee66;background:#22d3ee11}
```

New (append right after):
```css
.ctrl-btn.tag-subtitle{color:#22d3ee55;border-color:#22d3ee22}
.ctrl-btn.tag-subtitle.on{color:#22d3ee;border-color:#22d3ee66;background:#22d3ee11}
.ctrl-btn.tag-mute{color:#fb923c;border-color:#fb923c44}
.ctrl-btn.tag-mute:hover{background:#fb923c11}
```

(`tag-mute` has no `.on` variant — unlike Recon/Thumb/Short/VOD it's an action button, not a toggle, so it's always in this one visual state.)

- [ ] **Step 2: Add the Mute button and rename CC→VOD**

Current (`projects/Edit/edit/edit.html:3002-3011`):
```html
    <div class="ctrl-row">
      <input class="ctrl-in" id="cut-from-${clip.id}" value="0:00" placeholder="from">
      <span class="ctrl-lbl">→</span>
      <input class="ctrl-in" id="cut-to-${clip.id}" value="0:05" placeholder="to">
      <button class="ctrl-btn" onclick="addCut('${clip.id}')" ${getActiveKeep(cs,clip)[1]>=clip.duration-0.1?'disabled style="border-color:#f5ff3d44;color:#f5ff3d;padding:4px 8px;opacity:0.3;cursor:not-allowed"':'style="border-color:#f5ff3d44;color:#f5ff3d;padding:4px 8px"'} title="Зберегти сегмент"><svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5.5" y1="1" x2="5.5" y2="10"/><line x1="1" y1="5.5" x2="10" y2="5.5"/></svg></button>
      <button class="ctrl-btn tag-recon-src ${isReconSrc?'on':''}" onclick="setReconnectSource('${clip.id}')">⟳ Recon</button>
      <button class="ctrl-btn tag-thumb ${isThumb?'on':''}" data-tag="thumb" onclick="toggleTag(event,'${clip.id}','thumb')">🖼 Thumb</button>
      <button class="ctrl-btn tag-short ${isShort?'on':''}" data-tag="short" onclick="toggleTag(event,'${clip.id}','short')">✂ Short</button>
      <button class="ctrl-btn tag-subtitle ${isSubtitle?'on':''}" data-tag="subtitle" onclick="toggleTag(event,'${clip.id}','subtitle')" style="display:inline-flex;align-items:center;gap:3px"><svg width="15" height="11" viewBox="0 0 15 11" fill="none"><rect x=".5" y=".5" width="14" height="10" rx="1.5" stroke="currentColor"/><line x1="2.5" y1="5" x2="12.5" y2="5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="2.5" y1="7.8" x2="8.5" y2="7.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>CC</button>
    </div>
    <div id="cuts-list-${clip.id}"></div>
    <div id="timing-extras-${clip.id}"></div>`;
```

New:
```html
    <div class="ctrl-row">
      <input class="ctrl-in" id="cut-from-${clip.id}" value="0:00" placeholder="from">
      <span class="ctrl-lbl">→</span>
      <input class="ctrl-in" id="cut-to-${clip.id}" value="0:05" placeholder="to">
      <button class="ctrl-btn" onclick="addCut('${clip.id}')" ${getActiveKeep(cs,clip)[1]>=clip.duration-0.1?'disabled style="border-color:#f5ff3d44;color:#f5ff3d;padding:4px 8px;opacity:0.3;cursor:not-allowed"':'style="border-color:#f5ff3d44;color:#f5ff3d;padding:4px 8px"'} title="Зберегти сегмент"><svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5.5" y1="1" x2="5.5" y2="10"/><line x1="1" y1="5.5" x2="10" y2="5.5"/></svg></button>
      <button class="ctrl-btn tag-recon-src ${isReconSrc?'on':''}" onclick="setReconnectSource('${clip.id}')">⟳ Recon</button>
      <button class="ctrl-btn tag-thumb ${isThumb?'on':''}" data-tag="thumb" onclick="toggleTag(event,'${clip.id}','thumb')">🖼 Thumb</button>
      <button class="ctrl-btn tag-short ${isShort?'on':''}" data-tag="short" onclick="toggleTag(event,'${clip.id}','short')">✂ Short</button>
      <button class="ctrl-btn tag-subtitle ${isSubtitle?'on':''}" data-tag="subtitle" onclick="toggleTag(event,'${clip.id}','subtitle')" style="display:inline-flex;align-items:center;gap:3px"><svg width="15" height="11" viewBox="0 0 15 11" fill="none"><rect x=".5" y=".5" width="14" height="10" rx="1.5" stroke="currentColor"/><line x1="2.5" y1="5" x2="12.5" y2="5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="2.5" y1="7.8" x2="8.5" y2="7.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>VOD</button>
      <button class="ctrl-btn tag-mute" onclick="addManualMute('${clip.id}')" title="Позначити матюк у поточній позиції відео">🔇 Mute</button>
    </div>
    <div id="cuts-list-${clip.id}"></div>
    <div id="timing-extras-${clip.id}"></div>`;
```

- [ ] **Step 3: Add `addManualMute`/`removeManualMute` functions**

Current (`projects/Edit/edit/edit.html:2742-2786`, the end of `toggleTag`):
```js
    } else if (tag === 'short') {
      const btn = document.getElementById('shorts-mode-btn-' + clipId);
      if (btn) setPlayMode(clipId, 'shorts', btn);
    }
  }
}

// ── SORTABLE ──────────────────────────────────────────────────────────────────
```

New (insert the two new functions right after `toggleTag`'s closing brace, before the SORTABLE section):
```js
    } else if (tag === 'short') {
      const btn = document.getElementById('shorts-mode-btn-' + clipId);
      if (btn) setPlayMode(clipId, 'shorts', btn);
    }
  }
}

// Mute is an action button, not a toggle like Recon/Thumb/Short/VOD — a clip
// can contain more than one missed curse word, so every click adds a new
// mark at the current playback position (mirrors the "+" addCut pattern).
function addManualMute(clipId) {
  const video = document.getElementById('vid-' + clipId);
  const currentTime = video ? +video.currentTime.toFixed(2) : 0;
  const cs = getClipState(clipId);
  if (!cs.manualMutes) cs.manualMutes = [];
  cs.manualMutes.push({ at: currentTime });
  saveState();
  updateTimingExtras(clipId);
}

function removeManualMute(clipId, idx) {
  const cs = getClipState(clipId);
  if (!cs.manualMutes) return;
  cs.manualMutes.splice(idx, 1);
  saveState();
  updateTimingExtras(clipId);
}

// ── SORTABLE ──────────────────────────────────────────────────────────────────
```

- [ ] **Step 4: Display manual mute marks in `updateTimingExtras`**

Current (`projects/Edit/edit/edit.html:2898-2912`):
```js
function updateTimingExtras(clipId) {
  const el = document.getElementById('timing-extras-' + clipId);
  if (!el) return;
  let html = '';
  const src = state.reconnectSource;
  if (src && src.clipId === clipId) {
    html += `<div class="ctrl-row" style="margin-top:5px"><span style="color:#ff6b6b;font-size:11px;font-family:monospace">⟳ ${fmtTime(src.from)} → ${fmtTime(src.to)}</span></div>`;
  }
  const thumbEntry = getThumbEntry(clipId);
  if (thumbEntry) {
    html += `<div class="ctrl-row" style="margin-top:5px">
      <span style="color:#4ade80;font-size:11px;font-family:monospace">🖼 ${fmtTime(thumbEntry.at)}</span>
    </div>`;
  }
  el.innerHTML = html;
```

New:
```js
function updateTimingExtras(clipId) {
  const el = document.getElementById('timing-extras-' + clipId);
  if (!el) return;
  let html = '';
  const src = state.reconnectSource;
  if (src && src.clipId === clipId) {
    html += `<div class="ctrl-row" style="margin-top:5px"><span style="color:#ff6b6b;font-size:11px;font-family:monospace">⟳ ${fmtTime(src.from)} → ${fmtTime(src.to)}</span></div>`;
  }
  const thumbEntry = getThumbEntry(clipId);
  if (thumbEntry) {
    html += `<div class="ctrl-row" style="margin-top:5px">
      <span style="color:#4ade80;font-size:11px;font-family:monospace">🖼 ${fmtTime(thumbEntry.at)}</span>
    </div>`;
  }
  const cs = getClipState(clipId);
  (cs.manualMutes || []).forEach((m, i) => {
    html += `<div class="ctrl-row" style="margin-top:5px">
      <span style="color:#fb923c;font-size:11px;font-family:monospace">🔇 ${fmtTime(m.at)}</span>
      <button class="ctrl-btn" style="padding:0;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:13px;border-color:#fb923c22;color:#888;flex-shrink:0" onclick="removeManualMute('${clipId}',${i})">×</button>
    </div>`;
  });
  el.innerHTML = html;
```

- [ ] **Step 5: Serialize `manualMutes` into the exported editorial JSON**

Current (`projects/Edit/edit/edit.html:4161-4170`):
```js
  state.order.forEach(id => {
    if (id.startsWith('__recon_')) return;
    const cs = state.clips[id] || {};
    const entry = {};
    const clip = getClip(id);
    if (cs.keeps && cs.keeps.length > 0 && clip && isTrimmedKeeps(cs.keeps, clip)) entry.keeps = cs.keeps;
    if (cs.short) entry.short = cs.short;
    if (Object.keys(entry).length > 0) out.clips[id] = entry;
    if (cs.subtitle) vodClipIds.push(id);
  });
```

New:
```js
  state.order.forEach(id => {
    if (id.startsWith('__recon_')) return;
    const cs = state.clips[id] || {};
    const entry = {};
    const clip = getClip(id);
    if (cs.keeps && cs.keeps.length > 0 && clip && isTrimmedKeeps(cs.keeps, clip)) entry.keeps = cs.keeps;
    if (cs.short) entry.short = cs.short;
    if (cs.manualMutes && cs.manualMutes.length > 0) entry.manualMutes = cs.manualMutes;
    if (Object.keys(entry).length > 0) out.clips[id] = entry;
    if (cs.subtitle) vodClipIds.push(id);
  });
```

- [ ] **Step 6: Manual verification in a browser**

Open any existing episode's `edit/edit.html` (or `projects/Edit/edit/edit.html` itself, the template). Confirm:
- The tag row now shows `⟳ Recon`, `🖼 Thumb`, `✂ Short`, `VOD` (not `CC`), `🔇 Mute`.
- Playing a clip and clicking `🔇 Mute` adds an orange `🔇 0:0X.X` row with a `×` under the card; clicking Mute again while playing at a different position adds a second row; `×` removes just that one.
- Click "Copy Prompt" (or inspect `updatePrompt()`'s output textarea) and confirm a clip with a mute mark has `"manualMutes": [{"at": ...}]` in its entry.

- [ ] **Step 7: Commit**

```bash
git add projects/Edit/edit/edit.html
git commit -m "Add manual Mute marker button to edit.html, rename CC button to VOD"
```

---

### Task 7: `scripts/gen-review.js` — show censored words in the Tags column

**Files:**
- Modify: `scripts/gen-review.js:103-116`

- [ ] **Step 1: Add a censor-log reader and extend the Tags cell**

Current (`scripts/gen-review.js:103-116`):
```js
  // Tags cell
  const edClip = (editorial.clips || {})[id] || {};
  const tags = [];
  if ((plan.shortClipIds || []).includes(id)) {
    const mode = edClip.short?.mode || 'desktop';
    tags.push(`<span style="color:#a78bfa;font-size:10px;font-weight:700">SHORT:${mode.toUpperCase()}</span>`);
  }
  const isThumb = (editorial.thumbnails || []).some(t => t.clipId === id);
  if (isThumb) tags.push(`<span style="color:#4ade80;font-size:10px;font-weight:700">THUMB</span>`);
  const cuts = (edClip.keeps || []).length;
  if (cuts > 0) tags.push(`<span style="color:#f5ff3d;font-size:10px;font-family:monospace">✂${cuts}</span>`);
  if ((editorial.vodClipIds || []).includes(id))
    tags.push(`<span style="color:#38bdf8;font-size:10px;font-weight:700">VOD</span>`);
  const tagsStr = tags.join(' ') || '—';
```

New:
```js
  // Tags cell
  const edClip = (editorial.clips || {})[id] || {};
  const tags = [];
  if ((plan.shortClipIds || []).includes(id)) {
    const mode = edClip.short?.mode || 'desktop';
    tags.push(`<span style="color:#a78bfa;font-size:10px;font-weight:700">SHORT:${mode.toUpperCase()}</span>`);
  }
  const isThumb = (editorial.thumbnails || []).some(t => t.clipId === id);
  if (isThumb) tags.push(`<span style="color:#4ade80;font-size:10px;font-weight:700">THUMB</span>`);
  const cuts = (edClip.keeps || []).length;
  if (cuts > 0) tags.push(`<span style="color:#f5ff3d;font-size:10px;font-family:monospace">✂${cuts}</span>`);
  if ((editorial.vodClipIds || []).includes(id))
    tags.push(`<span style="color:#38bdf8;font-size:10px;font-weight:700">VOD</span>`);
  const censorLog = readJsonSafe(path.join(projectDir, 'processed', id, 'censor-log.json'), []);
  for (const c of censorLog) {
    tags.push(`<span style="color:#fb923c;font-size:10px;font-family:monospace">🔇 ${esc(c.word || 'manual')}@${c.start}s</span>`);
  }
  const tagsStr = tags.join(' ') || '—';
```

- [ ] **Step 2: Verify `readJsonSafe` is already imported**

Run: `grep -n "readJsonSafe" scripts/gen-review.js`
Expected: it's already destructured from `./lib/state` at the top of the file (line 5) — no new import needed. If this grep shows otherwise, add `readJsonSafe` to the existing `require('./lib/state')` destructure at the top of the file before proceeding.

- [ ] **Step 3: Syntax check**

Run: `node -c scripts/gen-review.js`
Expected: no output (exit code 0).

- [ ] **Step 4: Manual verification**

Run `gen-review.js` against a project that has at least one clip with a non-empty `censor-log.json` (produced by Task 3's Step 3):
```bash
node scripts/gen-review.js "projects/2026_07_July/Episode_49_2026_07_24"
```
Open the generated `review/review.html` in a browser and confirm the Clips table's Tags column shows a `🔇 word@Xs` badge for that clip, alongside any existing `SHORT`/`THUMB`/`✂N`/`VOD` badges.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-review.js
git commit -m "Show censored profanity words in review.html Tags column"
```

---

### Task 8: `CLAUDE.md` — document the new pipeline stage

**Files:**
- Modify: `CLAUDE.md` (Stage 2 pipeline list, file structure tree, "Перевірки звуку і перебивки" section)

- [ ] **Step 1: Insert stage 8b in the Stage 2 pipeline list**

Current:
```
8.  TRANSCRIBE       WhisperX large-v3 → transcript.json (тільки вибрані кліпи, з clean.mp4)
9.  OVERLAYS         Puppeteer → streamer overlay + reconnecting panel
```

New:
```
8.  TRANSCRIBE       WhisperX large-v3 → transcript.json (тільки вибрані кліпи, з clean.mp4)
8b. CENSOR           apply-censor.js → мьютить Tier 1/2 матюки/слюри в clean.mp4
                     (за word-level таймстемпами з transcript.json + ручні
                     позначки 🔇 Mute з edit.html), підставляє glitch.wav
9.  OVERLAYS         Puppeteer → streamer overlay + reconnecting panel
```

- [ ] **Step 2: Add censor artifacts to the file structure tree**

Current:
```
├── processed/<clipId>/
│   ├── transcript.json
│   ├── clean.mp4                      # trimmed + re-encoded (CRF 18, 30fps) + loudnorm
│   ├── edit-hash.txt                  # хеш editorial-рішень для інвалідації кешу
│   ├── overlayed.mp4                  # clean.mp4 + animated MKV broadcaster overlay
│   ├── captions-vertical.ass
│   └── frames/                        # 3 JPEG кадри (frame-1/2/3.jpg) + frames-hash.txt
```

New:
```
├── processed/<clipId>/
│   ├── transcript.json
│   ├── clean.mp4                      # trimmed + re-encoded (CRF 18, 30fps) + loudnorm + censored
│   ├── edit-hash.txt                  # хеш editorial-рішень для інвалідації кешу
│   ├── censor-log.json                # список замьючених слів/міток (слово, час, source: auto/manual)
│   ├── censor-hash.txt                # хеш mute-вікон для інвалідації кешу цензури
│   ├── overlayed.mp4                  # clean.mp4 + animated MKV broadcaster overlay
│   ├── captions-vertical.ass
│   └── frames/                        # 3 JPEG кадри (frame-1/2/3.jpg) + frames-hash.txt
```

- [ ] **Step 3: Add a "Перевірки звуку і перебивки" bullet documenting CENSOR's failure mode**

Find the existing bullet list under `## Перевірки звуку і перебивки` (bullets for APPLY_EDITORIAL, VOD replace, Реконект, BUILD_CONCAT, RENDER LONG). Add one more bullet, in the same style, after the "VOD replace" bullet and before "Реконект":

```
- **CENSOR** — `apply-censor.js` мьютить Tier 1/2 матюки/слюри (word-level
  таймстемпи з `transcript.json`) + ручні позначки 🔇 Mute з `edit.html`,
  підставляючи `assets/sounds/glitch.wav` у вирізаний проміжок. Працює
  ДО OVERLAYS — тому `apply-overlays.js` в `stage2.js` більше не стартує
  паралельно з TRANSCRIBE, а чекає завершення CENSOR (інакше overlays
  прочитав би ще нецензурований `clean.mp4`).
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Document CENSOR pipeline stage in CLAUDE.md"
```

---

### Task 9: `.claude/skills/ddos-render/SKILL.md` — document apply-censor.js

**Files:**
- Modify: `.claude/skills/ddos-render/SKILL.md`

- [ ] **Step 1: Insert a CENSOR section between APPLY_EDITORIAL and OVERLAYS**

Current (`.claude/skills/ddos-render/SKILL.md:25-29`):
```
Оновити `state.stages.trim` (`done` / `done_with_errors` / `failed` — скрипт ставить сам).

---

## OVERLAYS — Puppeteer frame-by-frame → FFV1 MKV
```

New:
```
Оновити `state.stages.trim` (`done` / `done_with_errors` / `failed` — скрипт ставить сам).

---

## CENSOR — Мьют матюків/слюрів + glitch.wav

Виконується автоматично в `stage2.js` між TRANSCRIBE і OVERLAYS (серіально — OVERLAYS
читає `clean.mp4`, тож має чекати, поки CENSOR допише в нього цензуроване аудіо).

```bash
node scripts/apply-censor.js "<projectDir>"
```

Скрипт:
- Для кожного кліпу читає `processed/<clipId>/transcript.json` (word-level таймстемпи)
  і `edit/editorial.json → clips[id].manualMutes` (ручні позначки 🔇 Mute з edit.html)
- Список слів для мьюту — `scripts/lib/profanity.js` (Tier 1 матюки + Tier 2 слюри,
  без м'яких слів типу damn/hell/crap)
- Кожне знайдене слово: мьютить оригінальне аудіо в межах `[word.start-40ms, word.end+40ms]`
  (clamp щоб не зайти в сусіднє слово) і підмішує `assets/sounds/glitch.wav`, обрізаний
  точно під це вікно — не вилазить у сусіднє слово
- Ручні позначки: вікно `[at, at + тривалість glitch.wav]`
- Перезаписує `clean.mp4` на місці (відео — `-c:v copy`, без перекодування;
  лише аудіо-фільтр) — тому `apply-overlays.js`, `build-concat.js`, `render-shorts.js`
  нічого не треба міняти, вони й так читають `clean.mp4`/`overlayed.mp4`
- Кешування: `processed/<clipId>/censor-hash.txt` — пропускає кліп, якщо набір
  mute-вікон не змінився з минулого запуску
- Пише `processed/<clipId>/censor-log.json` (слово/маска/час/джерело auto|manual)
  для аудиту — показується в review.html Tags column

Оновити `state.stages.censor` (`done` / `done_with_errors` / `failed` — скрипт ставить сам).

---

## OVERLAYS — Puppeteer frame-by-frame → FFV1 MKV
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/ddos-render/SKILL.md
git commit -m "Document CENSOR step in ddos-render skill"
```

---

### Task 10: `.claude/skills/ddos-shorts/SKILL.md` — replace HOT-list note with masking note

**Files:**
- Modify: `.claude/skills/ddos-shorts/SKILL.md:25-26`

- [ ] **Step 1: Replace the HOT words paragraph**

Current (`.claude/skills/ddos-shorts/SKILL.md:25-26`):
```
Hot слова (стиль Hot = білий для контрасту) — тільки справжні емоційні маркери:
no, what, wait, stop, wtf, omg, insane, crazy, holy, hell, wow, damn, bruh, nah
```

New:
```
Профанність (Tier 1 матюки + Tier 2 слюри, список — `scripts/lib/profanity.js`)
маскується в тексті капшенів: перша+остання літера лишаються, середина — зірочки
(`fuck` → `f**k`). Це та сама цензура, що йде в аудіо через `apply-censor.js` —
слово вже вирізане з доріжки на цьому моменті, капшен більше не має його показувати.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/ddos-shorts/SKILL.md
git commit -m "Update ddos-shorts skill doc: HOT list removed, profanity masking documented"
```

---

## Self-Review Notes

**Spec coverage check** (against `docs/superpowers/specs/2026-07-26-profanity-censorship-design.md`):
- Word list (Tier 1+2, no Tier 3) → Task 1 ✓
- Pipeline placement (8b, between TRANSCRIBE/OVERLAYS, in-place `clean.mp4` overwrite) → Tasks 3-4 ✓
- Captions masking + HOT removal → Task 5 ✓
- Manual Mute button (action-style, not toggle) + CC→VOD rename → Task 6 ✓
- review.html Tags column (no new section) → Task 7 ✓
- Caching (`censor-hash.txt`) → Task 3 ✓
- `interp`/`retimed` words still censored → Task 3's `buildMuteWindows` doesn't special-case these flags at all, i.e. treats them the same as any other word — matches "Мьютити все рівно" decision ✓
- Docs (`CLAUDE.md`, both skill docs) → Tasks 8-10 ✓

**Type/name consistency check:** `manualMutes` (state/editorial field), `censor-log.json` shape `{word, masked, start, end, source}`, `stages.censor` — used identically across Tasks 3, 6, 7, 8, 9. `apply-censor.js` is invoked with `projectDir` (not `runId`) everywhere it's called (Task 4's `stage2.js` edit, Task 8/9 docs) — matches its sibling `apply-overlays.js`'s calling convention, not `apply-editorial.js`'s (`runId`).

**No placeholders:** every step above has literal, complete code — no "add appropriate handling" language.
