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
