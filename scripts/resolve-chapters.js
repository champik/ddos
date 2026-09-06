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
