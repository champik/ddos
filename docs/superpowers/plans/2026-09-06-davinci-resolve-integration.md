# DaVinci Resolve Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new manual commands, `/ddos resolve assemble <runId>` and `/ddos resolve chapters <runId>`, that automate the mechanical parts of moving from `processed/clean/`+`processed/streamers_name/` into a DaVinci Resolve project — building the timeline in editorial order with intro/outro and streamer-name overlays, and later extracting real YouTube chapter timecodes from the manually-trimmed result.

**Architecture:** Node scripts own all DDOS-specific knowledge (naming conventions, editorial ordering, streamer display names) and produce plain data; a single Python script (`scripts/resolve_ctl.py`) talks to a running DaVinci Resolve instance through its official Scripting API and does nothing DDOS-specific. This mirrors the existing `transcribe-batch.js` → `transcribe-batch.py` split already used for Whisper.

**Tech Stack:** Node.js (existing `scripts/lib/*`), Python 3 + `DaVinciResolveScript` (Blackmagic's official Resolve Scripting API, free version), ffprobe (via existing `scripts/lib/media-probe.js`).

**Spec:** `docs/superpowers/specs/2026-09-06-davinci-resolve-integration-design.md`

---

## File Structure

- `scripts/lib/resolve-manifest.js` — **create.** Pure function: editorial.json + downloaded-clips.json + per-clip durations → the JSON manifest `resolve_ctl.py assemble` consumes. No filesystem access, fully unit-testable.
- `scripts/lib/resolve-manifest.test.js` — **create.**
- `scripts/lib/resolve-chapters-format.js` — **create.** Pure function: ordered list of matched timeline clips → display lines for `exports/chapters.txt` (merges consecutive same-streamer clips, shifts first entry to `0:00`). No filesystem access.
- `scripts/lib/resolve-chapters-format.test.js` — **create.**
- `scripts/resolve-assemble.js` — **create.** CLI wrapper: resolves paths, checks files exist, probes durations, builds the manifest, spawns `resolve_ctl.py assemble`.
- `scripts/resolve-chapters.js` — **create.** CLI wrapper: spawns `resolve_ctl.py chapters`, resolves basenames back to streamer display names, writes `exports/chapters.txt`.
- `scripts/resolve_ctl.py` — **create.** All actual DaVinci Resolve Scripting API calls (`assemble` and `chapters` subcommands).
- `.claude/commands/resolve.md` — **create.** `/ddos resolve assemble|chapters <runId>` command entry point (same pattern as `.claude/commands/status.md`).
- `package.json` — **modify** (`scripts.test` line) to run the two new test files.

---

### Task 1: `resolve-manifest.js` — pure assemble-manifest builder

**Files:**
- Create: `scripts/lib/resolve-manifest.js`
- Test: `scripts/lib/resolve-manifest.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/lib/resolve-manifest.test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { buildAssembleManifest, OVERLAY_MAX_DURATION_S } = require('./resolve-manifest');

let failed = false;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failed = true; console.error(`  FAIL - ${name}\n    ${e.message}`); }
}

const downloaded = [
  { id: 'a1', broadcaster_name: 'xQc' },
  { id: 'b2', broadcaster_name: 'Kai Cenat' },
];

console.log('buildAssembleManifest');

test('builds clips in clipOrder order, skips __recon markers', () => {
  const editorial = { clipOrder: ['a1', '__recon1', 'b2'] };
  const m = buildAssembleManifest({
    runId: 'Episode_1_2026_01_01', editorial, downloaded,
    clipDurations: { a1: 10, b2: 8 },
    projectDir: '/proj', introPath: '/intro.mp4', outroPath: '/outro.mp4',
  });
  assert.deepStrictEqual(m.clips.map(c => c.clipId), ['a1', 'b2']);
});

test('overlay duration is 5s when the clip is long enough', () => {
  const editorial = { clipOrder: ['a1'] };
  const m = buildAssembleManifest({
    runId: 'r', editorial, downloaded, clipDurations: { a1: 30 },
    projectDir: '/proj', introPath: '/i.mp4', outroPath: '/o.mp4',
  });
  assert.strictEqual(m.clips[0].overlayDuration, OVERLAY_MAX_DURATION_S);
});

test('overlay duration clamps exactly at the minimum 6s clip length', () => {
  const editorial = { clipOrder: ['a1'] };
  const m = buildAssembleManifest({
    runId: 'r', editorial, downloaded, clipDurations: { a1: 6 },
    projectDir: '/proj', introPath: '/i.mp4', outroPath: '/o.mp4',
  });
  assert.strictEqual(m.clips[0].overlayDuration, 5); // ends exactly at clip end, no overrun
});

test('overlay duration clamps further for a shorter-than-expected clip', () => {
  const editorial = { clipOrder: ['a1'] };
  const m = buildAssembleManifest({
    runId: 'r', editorial, downloaded, clipDurations: { a1: 4 },
    projectDir: '/proj', introPath: '/i.mp4', outroPath: '/o.mp4',
  });
  assert.strictEqual(m.clips[0].overlayDuration, 3); // 4s clip - 1s start offset
});

test('throws when a clip in clipOrder has no known duration', () => {
  const editorial = { clipOrder: ['a1'] };
  assert.throws(() => buildAssembleManifest({
    runId: 'r', editorial, downloaded, clipDurations: {},
    projectDir: '/proj', introPath: '/i.mp4', outroPath: '/o.mp4',
  }), /missing duration/);
});

test('clip/overlay paths are joined under projectDir/processed', () => {
  const editorial = { clipOrder: ['a1'] };
  const m = buildAssembleManifest({
    runId: 'r', editorial, downloaded, clipDurations: { a1: 10 },
    projectDir: path.join('proj'), introPath: '/i.mp4', outroPath: '/o.mp4',
  });
  const basename = m.clips[0].basename;
  assert.strictEqual(m.clips[0].clipPath, path.join('proj', 'processed', 'clean', `${basename}.mp4`));
  assert.strictEqual(m.clips[0].overlayPath, path.join('proj', 'processed', 'streamers_name', `${basename}.png`));
});

if (failed) process.exit(1);
console.log('\nAll resolve-manifest tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/resolve-manifest.test.js`
Expected: `Error: Cannot find module './resolve-manifest'`

- [ ] **Step 3: Write the implementation**

```javascript
// scripts/lib/resolve-manifest.js
'use strict';
// resolve-manifest.js — pure builder for the assemble manifest consumed by
// scripts/resolve_ctl.py. Keeps all DDOS naming/ordering/duration knowledge in
// Node; resolve_ctl.py only executes mechanical Resolve API calls from this
// data — it doesn't know what a "basename" or "clipOrder" is.

const path = require('path');
const { buildBasenameMap } = require('./clip-naming');

const OVERLAY_START_OFFSET_S = 1;   // overlay appears 1s into each clip
const OVERLAY_MAX_DURATION_S = 5;   // fixed 5s window, clamped to clip length
const OVERLAY_TRANSFORM = { zoomX: 0.25, zoomY: 0.25, pan: -1800, tilt: -400 };

// editorial: parsed editorial.json ({ clipOrder, ... })
// downloaded: parsed downloaded-clips.json (array)
// clipDurations: { [clipId]: durationSeconds } — real ffprobe'd duration of
//   processed/clean/<basename>.mp4. Passed in (not probed here) so this stays
//   a pure, filesystem-free function.
// projectDir: absolute path to the project directory
// introPath / outroPath: absolute paths to the fixed intro/outro assets
function buildAssembleManifest({ runId, editorial, downloaded, clipDurations, projectDir, introPath, outroPath }) {
  const clipIds = (editorial.clipOrder || []).filter(id => !String(id).startsWith('__recon'));
  const basenames = buildBasenameMap(editorial.clipOrder, downloaded);
  const dlById = Object.fromEntries((downloaded || []).map(c => [c.id, c]));

  const clips = clipIds.map(clipId => {
    const basename = basenames[clipId];
    const duration = clipDurations[clipId];
    if (duration == null) {
      throw new Error(`buildAssembleManifest: missing duration for clip ${clipId} (${basename})`);
    }
    const overlayDuration = Math.max(0, Math.min(OVERLAY_MAX_DURATION_S, duration - OVERLAY_START_OFFSET_S));
    const clip = dlById[clipId];
    return {
      clipId,
      basename,
      duration,
      clipPath: path.join(projectDir, 'processed', 'clean', `${basename}.mp4`),
      overlayPath: path.join(projectDir, 'processed', 'streamers_name', `${basename}.png`),
      overlayStartOffset: OVERLAY_START_OFFSET_S,
      overlayDuration,
      streamer: clip ? (clip.broadcaster_name || clip.broadcaster_login) : clipId,
    };
  });

  return {
    runId,
    resolveProjectName: runId,
    timelineName: 'Episode',
    introPath,
    outroPath,
    clips,
    overlayTransform: OVERLAY_TRANSFORM,
  };
}

module.exports = { buildAssembleManifest, OVERLAY_START_OFFSET_S, OVERLAY_MAX_DURATION_S, OVERLAY_TRANSFORM };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/lib/resolve-manifest.test.js`
Expected: `All resolve-manifest tests passed.` (6 `ok -` lines, exit code 0)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/resolve-manifest.js scripts/lib/resolve-manifest.test.js
git commit -m "Add pure builder for DaVinci Resolve assemble manifest

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `resolve-chapters-format.js` — pure chapters formatter

**Files:**
- Create: `scripts/lib/resolve-chapters-format.js`
- Test: `scripts/lib/resolve-chapters-format.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/lib/resolve-chapters-format.test.js
'use strict';
const assert = require('assert');
const { formatChapterLines, formatTimestamp } = require('./resolve-chapters-format');

let failed = false;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failed = true; console.error(`  FAIL - ${name}\n    ${e.message}`); }
}

console.log('formatTimestamp');

test('formats under a minute', () => {
  assert.strictEqual(formatTimestamp(0), '0:00');
  assert.strictEqual(formatTimestamp(34), '0:34');
});

test('formats minutes with zero-padded seconds', () => {
  assert.strictEqual(formatTimestamp(154), '2:34');
  assert.strictEqual(formatTimestamp(605), '10:05');
});

console.log('formatChapterLines');

test('empty input -> empty output', () => {
  assert.deepStrictEqual(formatChapterLines([]), []);
});

test('single item always gets 0:00', () => {
  const items = [{ basename: '01_xqc_a1', startSeconds: 4.3, streamerName: 'xQc' }];
  assert.deepStrictEqual(formatChapterLines(items), ['0:00 xQc']);
});

test('first item is forced to 0:00 even with an intro offset before it', () => {
  const items = [
    { basename: '01_xqc_a1', startSeconds: 1.25, streamerName: 'xQc' },
    { basename: '02_kai_b2', startSeconds: 12.25, streamerName: 'Kai Cenat' },
  ];
  assert.deepStrictEqual(formatChapterLines(items), ['0:00 xQc', '0:11 Kai Cenat']);
});

test('consecutive same-streamer clips merge into one line', () => {
  const items = [
    { basename: '01_xqc_a1', startSeconds: 0, streamerName: 'xQc' },
    { basename: '02_xqc_a2', startSeconds: 10, streamerName: 'xQc' },
    { basename: '03_xqc_a3', startSeconds: 20, streamerName: 'xQc' },
    { basename: '04_kai_b1', startSeconds: 30, streamerName: 'Kai Cenat' },
  ];
  assert.deepStrictEqual(formatChapterLines(items), ['0:00 xQc', '0:30 Kai Cenat']);
});

test('the same streamer returning later (non-consecutive) gets its own line', () => {
  const items = [
    { basename: '01_xqc_a1', startSeconds: 0, streamerName: 'xQc' },
    { basename: '02_kai_b1', startSeconds: 10, streamerName: 'Kai Cenat' },
    { basename: '03_xqc_a2', startSeconds: 20, streamerName: 'xQc' },
  ];
  assert.deepStrictEqual(formatChapterLines(items), ['0:00 xQc', '0:10 Kai Cenat', '0:20 xQc']);
});

if (failed) process.exit(1);
console.log('\nAll resolve-chapters-format tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/resolve-chapters-format.test.js`
Expected: `Error: Cannot find module './resolve-chapters-format'`

- [ ] **Step 3: Write the implementation**

```javascript
// scripts/lib/resolve-chapters-format.js
'use strict';
// resolve-chapters-format.js — pure formatter for exports/chapters.txt.
// Input: ordered list of already-matched content clips read off the Resolve
// timeline ({ basename, startSeconds, streamerName }) — filtering out intro/
// outro/reconnecting/manual inserts already happened upstream (resolve_ctl.py
// chapters + resolve-chapters.js). Output: display lines ("m:ss Name").
//
// Two rules, both agreed with the user ahead of implementation:
// - consecutive clips by the same streamer merge into one line (matches
//   buildChapters() in lib/timeline.js, the old auto-render pipeline's
//   equivalent);
// - the first line is always "0:00" — YouTube requires the first chapter to
//   start there, so every timestamp is shown relative to the first matched
//   clip, not to the timeline's real (post-intro) start.

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatChapterLines(items) {
  if (!items || items.length === 0) return [];

  const offset = items[0].startSeconds;
  const lines = [];
  let lastStreamer = null;

  for (const item of items) {
    if (item.streamerName === lastStreamer) continue;
    lines.push(`${formatTimestamp(item.startSeconds - offset)} ${item.streamerName}`);
    lastStreamer = item.streamerName;
  }

  return lines;
}

module.exports = { formatChapterLines, formatTimestamp };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/lib/resolve-chapters-format.test.js`
Expected: `All resolve-chapters-format tests passed.` (8 `ok -` lines, exit code 0)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/resolve-chapters-format.js scripts/lib/resolve-chapters-format.test.js
git commit -m "Add pure formatter for DaVinci Resolve chapters output

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `resolve_ctl.py` — Resolve bootstrap + `assemble` subcommand

**Files:**
- Create: `scripts/resolve_ctl.py`

This talks to a live DaVinci Resolve process through its Scripting API — there is no way to unit test it without Resolve open (same situation as the rest of the pipeline's non-mockable ffmpeg/API steps). The verification for this task is a syntax check plus a documented manual checklist, not automated tests — do not claim more than that.

- [ ] **Step 1: Write the file**

```python
#!/usr/bin/env python
"""scripts/resolve_ctl.py — DaVinci Resolve control via the official Scripting API.

Called by scripts/resolve-assemble.js and scripts/resolve-chapters.js. This
script knows nothing about DDOS naming conventions — it only executes
mechanical Resolve operations from data it's handed (a manifest JSON for
`assemble`, CLI args for `chapters`).

Usage:
    python scripts/resolve_ctl.py assemble --manifest <path> [--force] [--dry-run]
    python scripts/resolve_ctl.py chapters --project-name <name> --timeline-name <name>
"""

import argparse
import json
import os
import re
import sys
import time

FPS = 30  # must match the CRF18/30fps encode in apply-editorial.js

# Matches basenames built by scripts/lib/clip-naming.js's buildClipBasename:
# "<2-digit position>_<sanitized streamer>_<8-char idSuffix|noid>". Used only
# to tell "one of our content clips" apart from intro/outro/reconnecting/
# anything the user added by hand — the actual streamer name is resolved back
# in Node (resolve-chapters.js), which has editorial.json/downloaded-clips.json.
BASENAME_RE = re.compile(r'^\d{2}_.+_([a-z0-9]{8}|noid)$')


def _bootstrap_resolve():
    """Import DaVinciResolveScript and connect to a running Resolve instance.
    Exits with a clear message on failure rather than leaving the caller to
    guess why nothing happened."""
    resolve_api = os.environ.get(
        'RESOLVE_SCRIPT_API',
        r'C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting',
    )
    modules_path = os.path.join(resolve_api, 'Modules')
    if modules_path not in sys.path:
        sys.path.append(modules_path)

    try:
        import DaVinciResolveScript as dvr_script
    except ImportError as e:
        sys.exit(
            'FATAL: cannot import DaVinciResolveScript.\n'
            f'  tried modules path: {modules_path}\n'
            '  set the RESOLVE_SCRIPT_API env var if DaVinci Resolve is installed elsewhere.\n'
            f'  underlying error: {e}'
        )

    resolve = dvr_script.scriptapp('Resolve')
    if resolve is None:
        sys.exit(
            'FATAL: DaVinci Resolve is not running (or external scripting is disabled).\n'
            '  open DaVinci Resolve first, then re-run this command.'
        )
    return resolve


def _find_or_create_project(project_manager, name):
    current = project_manager.GetCurrentProject()
    if current is not None and current.GetName() == name:
        return current, False
    if project_manager.LoadProject(name):
        return project_manager.GetCurrentProject(), False
    created = project_manager.CreateProject(name)
    if not created:
        sys.exit(f'FATAL: could not find or create Resolve project "{name}".')
    return created, True


def _configure_project_settings(project):
    # Must match the 30fps/1920x1080 encode of processed/clean/*.mp4 — a
    # mismatched timeline frame rate silently shifts every frame position
    # computed below.
    project.SetSetting('timelineResolutionWidth', '1920')
    project.SetSetting('timelineResolutionHeight', '1080')
    project.SetSetting('timelineFrameRate', str(FPS))


def _find_timeline(project, name):
    for i in range(1, project.GetTimelineCount() + 1):
        tl = project.GetTimelineByIndex(i)
        if tl.GetName() == name:
            return tl
    return None


def _backup_existing_timeline(project, name):
    existing = _find_timeline(project, name)
    if existing is None:
        return
    backup_name = f'{name}_backup_{int(time.time())}'
    existing.SetName(backup_name)
    print(f'[BACKUP] renamed existing timeline "{name}" -> "{backup_name}" (not deleted)')


def _import_media(media_pool, paths):
    """Import paths not already present in the pool (matched by file path).
    Returns {path: mediaPoolItem}. Safe to call repeatedly across re-runs."""
    root = media_pool.GetRootFolder()
    existing = {}
    for clip in root.GetClipList():
        existing[clip.GetClipProperty('File Path')] = clip

    to_import = [p for p in paths if p not in existing]
    if to_import:
        imported = media_pool.ImportMedia(to_import) or []
        for item in imported:
            existing[item.GetClipProperty('File Path')] = item

    missing = [p for p in paths if p not in existing]
    if missing:
        sys.exit('FATAL: Resolve failed to import:\n  ' + '\n  '.join(missing))

    return existing


def _print_dry_run(manifest):
    print(f'[DRY-RUN] project={manifest["resolveProjectName"]} timeline={manifest["timelineName"]}')
    print(f'[DRY-RUN] order: intro -> {len(manifest["clips"])} clip(s) -> outro')
    for c in manifest['clips']:
        print(f'  {c["basename"]}: duration={c["duration"]:.2f}s, '
              f'overlay at +{c["overlayStartOffset"]:.2f}s for {c["overlayDuration"]:.2f}s')
    t = manifest['overlayTransform']
    print(f'[DRY-RUN] overlay transform: zoom={t["zoomX"]}x{t["zoomY"]} pan={t["pan"]} tilt={t["tilt"]}')
    print('[DRY-RUN] no changes made — Resolve was not contacted')


def cmd_assemble(args):
    with open(args.manifest, encoding='utf-8') as f:
        manifest = json.load(f)

    if args.dry_run:
        _print_dry_run(manifest)
        return

    resolve = _bootstrap_resolve()
    pm = resolve.GetProjectManager()
    project, created = _find_or_create_project(pm, manifest['resolveProjectName'])
    if created:
        print(f'[PROJECT] created "{manifest["resolveProjectName"]}"')
    _configure_project_settings(project)

    timeline_name = manifest['timelineName']
    if _find_timeline(project, timeline_name) is not None:
        if not args.force:
            sys.exit(
                f'FATAL: timeline "{timeline_name}" already exists in project '
                f'"{manifest["resolveProjectName"]}". Re-run with --force to keep it as a '
                'backup (renamed, not deleted) and build a fresh one.'
            )
        _backup_existing_timeline(project, timeline_name)

    media_pool = project.GetMediaPool()
    all_paths = [manifest['introPath'], manifest['outroPath']] + \
        [c['clipPath'] for c in manifest['clips']] + \
        [c['overlayPath'] for c in manifest['clips']]
    pool_items = _import_media(media_pool, all_paths)

    timeline = media_pool.CreateEmptyTimeline(timeline_name)
    if not timeline:
        sys.exit(f'FATAL: could not create timeline "{timeline_name}".')
    project.SetCurrentTimeline(timeline)

    # Main sequence (video track 1, created automatically with a fresh
    # timeline): intro -> clips in editorial order -> outro. Plain cuts in
    # V1 — crossfade transitions are a separate follow-up pending the API
    # feasibility spike (see the design spec).
    main_sequence = [pool_items[manifest['introPath']]] + \
        [pool_items[c['clipPath']] for c in manifest['clips']] + \
        [pool_items[manifest['outroPath']]]
    appended = media_pool.AppendToTimeline(main_sequence)
    if not appended or len(appended) != len(main_sequence):
        sys.exit('FATAL: AppendToTimeline did not place every clip — aborting before the overlay pass.')

    # Dedicated overlay track above the main clips.
    timeline.AddTrack('video')
    overlay_track_index = timeline.GetTrackCount('video')

    for i, clip_manifest in enumerate(manifest['clips']):
        timeline_item = appended[i + 1]  # +1 skips the intro at index 0
        clip_start_frame = timeline_item.GetStart()
        overlay_start_frame = clip_start_frame + round(clip_manifest['overlayStartOffset'] * FPS)
        overlay_duration_frames = round(clip_manifest['overlayDuration'] * FPS)
        if overlay_duration_frames <= 0:
            print(f'  [SKIP] {clip_manifest["basename"]}: clip too short for the overlay window')
            continue

        overlay_item = media_pool.AppendToTimeline([{
            'mediaPoolItem': pool_items[clip_manifest['overlayPath']],
            'startFrame': 0,
            'endFrame': overlay_duration_frames - 1,
            'trackIndex': overlay_track_index,
            'recordFrame': overlay_start_frame,
        }])
        if not overlay_item:
            print(f'  [WARN] {clip_manifest["basename"]}: failed to place overlay')
            continue

        item = overlay_item[0]
        t = manifest['overlayTransform']
        item.SetProperty('ZoomX', t['zoomX'])
        item.SetProperty('ZoomY', t['zoomY'])
        item.SetProperty('Pan', t['pan'])
        item.SetProperty('Tilt', t['tilt'])
        print(f'  [OK] {clip_manifest["basename"]}: overlay @ frame {overlay_start_frame} for {overlay_duration_frames}f')

    print(f'[DONE] assembled "{timeline_name}" — {len(manifest["clips"])} clip(s) + intro/outro')
    print('[VERIFY] check overlay position/size on the first clip in Resolve before trimming — '
          'the zoom/pan/tilt values were carried over from CapCut and have not been visually '
          'confirmed inside Resolve.')


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)

    p_assemble = sub.add_parser('assemble')
    p_assemble.add_argument('--manifest', required=True)
    p_assemble.add_argument('--force', action='store_true')
    p_assemble.add_argument('--dry-run', action='store_true')
    p_assemble.set_defaults(func=cmd_assemble)

    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Syntax-check the file**

Run: `python -m py_compile scripts/resolve_ctl.py`
Expected: no output, exit code 0

- [ ] **Step 3: Manual verification checklist (record the outcome in the commit message body)**

With DaVinci Resolve open and a real episode that has finished `stage2.js` (`processed/clean/` + `processed/streamers_name/` populated):
1. `node scripts/resolve-assemble.js <runId> --dry-run` (will exist after Task 4) prints the expected clip list without touching Resolve.
2. `node scripts/resolve-assemble.js <runId>` creates project `<runId>`, timeline `Episode`, with intro → clips → outro in the right order.
3. Overlay PNGs appear on a second video track; visually confirm size (~25%) and position land somewhere sane on the first clip — if not, adjust `OVERLAY_TRANSFORM` in `scripts/lib/resolve-manifest.js` and re-run with `--force`.
4. Re-running `node scripts/resolve-assemble.js <runId>` without `--force` refuses and explains why; with `--force` the old timeline is renamed `Episode_backup_<timestamp>`, not deleted.

- [ ] **Step 4: Commit**

```bash
git add scripts/resolve_ctl.py
git commit -m "Add resolve_ctl.py assemble subcommand (DaVinci Resolve Scripting API)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `resolve-assemble.js` — Node CLI wrapper

**Files:**
- Create: `scripts/resolve-assemble.js`

- [ ] **Step 1: Write the file**

```javascript
#!/usr/bin/env node
// scripts/resolve-assemble.js — builds the assemble manifest from
// editorial.json + downloaded-clips.json and hands it to resolve_ctl.py,
// which does the actual Resolve API work.
// Usage: node scripts/resolve-assemble.js <runId> [--force] [--dry-run]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readJson } = require('./lib/state');
const { pythonBin } = require('./lib/sys');
const { getProjectDir } = require('./lib/project-path');
const { buildBasenameMap, processedTypeDir } = require('./lib/clip-naming');
const { getDuration } = require('./lib/media-probe');
const { buildAssembleManifest } = require('./lib/resolve-manifest');

const args = process.argv.slice(2);
const runId = args.find(a => !a.startsWith('--'));
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');

if (!runId) {
  console.error('Usage: node resolve-assemble.js <runId> [--force] [--dry-run]');
  process.exit(1);
}

const projectDir = getProjectDir(runId);
const editorial = readJson(path.join(projectDir, 'edit', 'editorial.json'));
const downloaded = readJson(path.join(projectDir, 'clips', 'downloaded-clips.json'));

const clipIds = (editorial.clipOrder || []).filter(id => !String(id).startsWith('__recon'));
const basenames = buildBasenameMap(editorial.clipOrder, downloaded);
const CLEAN_DIR = processedTypeDir(projectDir, 'clean');
const OVERLAY_DIR = processedTypeDir(projectDir, 'streamers_name');

const missing = [];
for (const clipId of clipIds) {
  const basename = basenames[clipId];
  const clipPath = path.join(CLEAN_DIR, `${basename}.mp4`);
  const overlayPath = path.join(OVERLAY_DIR, `${basename}.png`);
  if (!fs.existsSync(clipPath)) missing.push(clipPath);
  if (!fs.existsSync(overlayPath)) missing.push(overlayPath);
}

const introPath = path.resolve('assets/intro/intro_30fps.mp4');
const outroPath = path.resolve('assets/outro/outro_30fps.mp4');
if (!fs.existsSync(introPath)) missing.push(introPath);
if (!fs.existsSync(outroPath)) missing.push(outroPath);

if (missing.length > 0) {
  console.error('[FATAL] missing files, aborting before touching Resolve:');
  missing.forEach(p => console.error(`  ${p}`));
  process.exit(1);
}

const clipDurations = {};
for (const clipId of clipIds) {
  clipDurations[clipId] = getDuration(path.join(CLEAN_DIR, `${basenames[clipId]}.mp4`));
}

const manifest = buildAssembleManifest({
  runId, editorial, downloaded, clipDurations,
  projectDir: path.resolve(projectDir), introPath, outroPath,
});

const manifestPath = path.join(os.tmpdir(), `ddos-resolve-manifest-${Date.now()}.json`);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const pyArgs = ['scripts/resolve_ctl.py', 'assemble', '--manifest', manifestPath];
if (force) pyArgs.push('--force');
if (dryRun) pyArgs.push('--dry-run');

const proc = spawn(pythonBin(), pyArgs, { cwd: path.join(__dirname, '..') });
proc.stdout.on('data', d => process.stdout.write(d));
proc.stderr.on('data', d => process.stderr.write(d));
proc.on('close', (code) => {
  try { fs.unlinkSync(manifestPath); } catch {}
  process.exit(code);
});
proc.on('error', (e) => { console.error('[FATAL]', e.message); process.exit(1); });
```

- [ ] **Step 2: End-to-end smoke test with a fixture project (no Resolve required — `--dry-run` never touches it)**

This only exercises the Node-side wiring (manifest building, missing-file detection,
spawning Python with `--dry-run`) — `getDuration()` on an empty placeholder file
harmlessly returns `0` (ffprobe fails, `media-probe.js` falls back to `0`), so real
media files aren't needed here.

```bash
BASE=/tmp/ddos-resolve-smoke
rm -rf "$BASE"
mkdir -p "$BASE/projects/Test_1_2026_01_01/edit"
mkdir -p "$BASE/projects/Test_1_2026_01_01/clips"
mkdir -p "$BASE/projects/Test_1_2026_01_01/processed/clean"
mkdir -p "$BASE/projects/Test_1_2026_01_01/processed/streamers_name"
mkdir -p "$BASE/assets/intro" "$BASE/assets/outro"
touch "$BASE/assets/intro/intro_30fps.mp4" "$BASE/assets/outro/outro_30fps.mp4"
touch "$BASE/projects/Test_1_2026_01_01/processed/clean/01_xqc_a7k2m9qx.mp4"
touch "$BASE/projects/Test_1_2026_01_01/processed/streamers_name/01_xqc_a7k2m9qx.png"
echo '{"clipOrder": ["a1"]}' > "$BASE/projects/Test_1_2026_01_01/edit/editorial.json"
echo '[{"id": "a1", "broadcaster_name": "xQc"}]' > "$BASE/projects/Test_1_2026_01_01/clips/downloaded-clips.json"
(cd "$BASE" && node /d/Projects/ddos/scripts/resolve-assemble.js Test_1_2026_01_01 --dry-run)
rm -rf "$BASE"
```

Expected output:
```
[DRY-RUN] project=Test_1_2026_01_01 timeline=Episode
[DRY-RUN] order: intro -> 1 clip(s) -> outro
  01_xqc_a7k2m9qx: duration=0.00s, overlay at +1.00s for 0.00s
[DRY-RUN] overlay transform: zoom=0.25x0.25 pan=-1800 tilt=-400
[DRY-RUN] no changes made — Resolve was not contacted
```

If instead you see `[FATAL] missing files`, one of the `touch`/`mkdir` lines above was
skipped or the path doesn't match what `resolve-assemble.js` expects — compare the
printed missing-file list against the fixture layout and fix the mismatch before retrying.

- [ ] **Step 3: Commit**

```bash
git add scripts/resolve-assemble.js
git commit -m "Add resolve-assemble.js CLI wrapper

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `resolve_ctl.py` — `chapters` subcommand

**Files:**
- Modify: `scripts/resolve_ctl.py`

- [ ] **Step 1: Add the `chapters` command function**

Insert before `def main():`:

```python
def cmd_chapters(args):
    resolve = _bootstrap_resolve()
    pm = resolve.GetProjectManager()
    if not pm.LoadProject(args.project_name):
        sys.exit(f'FATAL: project "{args.project_name}" not found — run assemble first.')
    project = pm.GetCurrentProject()

    timeline = _find_timeline(project, args.timeline_name)
    if timeline is None:
        sys.exit(f'FATAL: timeline "{args.timeline_name}" not found in project "{args.project_name}".')

    fps = float(project.GetSetting('timelineFrameRate') or FPS)
    items = timeline.GetItemListInTrack('video', 1) or []

    matches = []
    for item in items:
        pool_item = item.GetMediaPoolItem()
        if not pool_item:
            continue
        file_path = pool_item.GetClipProperty('File Path') or ''
        basename = os.path.splitext(os.path.basename(file_path))[0]
        if not BASENAME_RE.match(basename):
            continue
        matches.append({'basename': basename, 'startSeconds': item.GetStart() / fps})

    matches.sort(key=lambda m: m['startSeconds'])
    print(json.dumps(matches))
```

- [ ] **Step 2: Wire up the subparser**

In `main()`, after the `p_assemble` block and before `args = parser.parse_args()`:

```python
    p_chapters = sub.add_parser('chapters')
    p_chapters.add_argument('--project-name', required=True)
    p_chapters.add_argument('--timeline-name', required=True)
    p_chapters.set_defaults(func=cmd_chapters)
```

- [ ] **Step 3: Syntax-check the file**

Run: `python -m py_compile scripts/resolve_ctl.py`
Expected: no output, exit code 0

- [ ] **Step 4: Manual verification checklist (record the outcome in the commit message body)**

With the Resolve project from Task 3's checklist, after manually trimming a couple of clips and moving the playhead around:
1. `python scripts/resolve_ctl.py chapters --project-name <runId> --timeline-name Episode` prints a single JSON array line to stdout.
2. The array is sorted by `startSeconds` and only contains basenames matching our `NN_streamer_idSuffix` pattern — intro/outro are absent.
3. Running it again after trimming another clip shows updated `startSeconds` — confirms it reads the live, current timeline state, not a cached one.

- [ ] **Step 5: Commit**

```bash
git add scripts/resolve_ctl.py
git commit -m "Add resolve_ctl.py chapters subcommand

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `resolve-chapters.js` — Node CLI wrapper

**Files:**
- Create: `scripts/resolve-chapters.js`

- [ ] **Step 1: Write the file**

```javascript
#!/usr/bin/env node
// scripts/resolve-chapters.js — reads the (already manually trimmed) Resolve
// timeline via resolve_ctl.py and writes exports/chapters.txt.
// Usage: node scripts/resolve-chapters.js <runId>

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readJson } = require('./lib/state');
const { pythonBin } = require('./lib/sys');
const { getProjectDir } = require('./lib/project-path');
const { buildBasenameMap } = require('./lib/clip-naming');
const { streamerDisplayName } = require('./lib/display-name');
const { formatChapterLines } = require('./lib/resolve-chapters-format');

const [, , runId] = process.argv;
if (!runId) { console.error('Usage: node resolve-chapters.js <runId>'); process.exit(1); }

const projectDir = getProjectDir(runId);
const editorial = readJson(path.join(projectDir, 'edit', 'editorial.json'));
const downloaded = readJson(path.join(projectDir, 'clips', 'downloaded-clips.json'));

const basenames = buildBasenameMap(editorial.clipOrder, downloaded);
const clipIdByBasename = Object.fromEntries(Object.entries(basenames).map(([id, b]) => [b, id]));
const dlById = Object.fromEntries(downloaded.map(c => [c.id, c]));

function main() {
  return new Promise((resolve) => {
    const proc = spawn(pythonBin(), [
      'scripts/resolve_ctl.py', 'chapters',
      '--project-name', runId,
      '--timeline-name', 'Episode',
    ], { cwd: path.join(__dirname, '..') });

    let stdout = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => process.stderr.write(d));

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[FATAL] resolve_ctl.py chapters exited ${code}`);
        resolve(1);
        return;
      }

      let rawMatches;
      try {
        rawMatches = JSON.parse(stdout.trim().split('\n').pop());
      } catch (e) {
        console.error('[FATAL] could not parse resolve_ctl.py output:', stdout);
        resolve(1);
        return;
      }

      if (rawMatches.length === 0) {
        console.error('[FATAL] no clips matched on the timeline — nothing to write to chapters.txt');
        resolve(1);
        return;
      }

      const items = rawMatches.map(m => {
        const clipId = clipIdByBasename[m.basename];
        const clip = clipId ? dlById[clipId] : null;
        return {
          basename: m.basename,
          startSeconds: m.startSeconds,
          streamerName: clip ? streamerDisplayName(clip) : m.basename,
        };
      });

      const lines = formatChapterLines(items);
      const outPath = path.join(projectDir, 'exports', 'chapters.txt');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
      console.log(`[DONE] wrote ${lines.length} chapter(s) to ${outPath}`);
      lines.forEach(l => console.log('  ' + l));
      resolve(0);
    });

    proc.on('error', (e) => { console.error('[FATAL]', e.message); resolve(1); });
  });
}

main().then(code => process.exit(code));
```

- [ ] **Step 2: Manual verification**

Against the same real project used in Task 5's checklist: `node scripts/resolve-chapters.js <runId>` writes `exports/chapters.txt` and prints the same lines to the console; open the file and confirm it matches what was printed.

- [ ] **Step 3: Commit**

```bash
git add scripts/resolve-chapters.js
git commit -m "Add resolve-chapters.js CLI wrapper

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: `/ddos resolve` command entry point

**Files:**
- Create: `.claude/commands/resolve.md`

- [ ] **Step 1: Write the file**

```markdown
# Команда: /ddos resolve

Автоматизує частину монтажу в DaVinci Resolve — деталі й межу автоматизація/вручну
дивись `docs/superpowers/specs/2026-09-06-davinci-resolve-integration-design.md`.

## /ddos resolve assemble <runId>

Складає Resolve-проєкт з `processed/clean/*.mp4` + `processed/streamers_name/*.png` у
порядку `editorial.json.clipOrder`, з intro/outro і overlay-позиціонуванням. Вимагає
відкритий DaVinci Resolve (без авто-запуску застосунку).

```bash
node scripts/resolve-assemble.js "<runId>"
```

Якщо таймлайн `Episode` вже існує в проєкті — команда відмовляється його перезбирати
без `--force`. З `--force` старий таймлайн перейменовується (`Episode_backup_<timestamp>`),
не видаляється — ручний монтаж, який там уже є, не втрачається.

```bash
node scripts/resolve-assemble.js "<runId>" --force
```

Перед першим реальним запуском на конкретному епізоді можна перевірити план без
дотику до Resolve:

```bash
node scripts/resolve-assemble.js "<runId>" --dry-run
```

Після успішного `assemble` — переказати користувачу останній рядок виводу
(`[VERIFY] check overlay position...`) і нагадати перевірити позицію/розмір overlay
на першому кліпі в Resolve, перш ніж різати кліпи далі.

## /ddos resolve chapters <runId>

Запускати ПІСЛЯ того, як користувач вручну поріз кліпи в Resolve (таймкоди рахуються
з поточного, вже зміненого стану таймлайну — не з моменту assemble).

```bash
node scripts/resolve-chapters.js "<runId>"
```

Пише `<projectDir>/exports/chapters.txt`, готовий вставити в опис YouTube вручну.
Якщо команда впала з `no clips matched on the timeline` — таймлайн у Resolve або
порожній, або всі кліпи перейменовано так, що вони більше не матчаться на
`NN_streamer_idSuffix`; повідомити користувачу і не писати порожній файл.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/commands/resolve.md
git commit -m "Add /ddos resolve command entry point

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Wire new tests into `npm test`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update the test script**

Change:
```json
    "test": "node scripts/lib/select.test.js && node scripts/lib/timeline.test.js && node scripts/lib/profanity.test.js && node scripts/lib/phrase-index.test.js"
```
to:
```json
    "test": "node scripts/lib/select.test.js && node scripts/lib/timeline.test.js && node scripts/lib/profanity.test.js && node scripts/lib/phrase-index.test.js && node scripts/lib/resolve-manifest.test.js && node scripts/lib/resolve-chapters-format.test.js"
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: all six test files print their `ok -` lines and exit 0; no `FAIL` lines.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "Run resolve-manifest and resolve-chapters-format tests in npm test

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Explicitly not in this plan

Crossfade transitions and the glitch-in/glitch-out overlay animation (the technical
spike from the design spec), reconnecting-panel automation, trim/cuts automation,
subtitles, Shorts, final export, auto-launching Resolve, the deferred screenshot-preview/
clip-color-coding/`verify` ideas. All tracked in the design spec's "Поза скоупом" /
"Відкладені ідеї" sections.
