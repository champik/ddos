'use strict';
const path = require('path');
const fs   = require('fs');

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

function monthFolderFromRunId(runId) {
  const m = runId.match(/_(\d{4})_(\d{2})_\d{2}$/);
  if (!m) return null;
  const mm = m[2];
  const name = MONTH_NAMES[parseInt(mm, 10) - 1];
  return `${m[1]}_${mm}_${name}`;
}

function getProjectDir(runId) {
  // Multi-day Special series use "<SeriesName>/Day_N" — a '/' never appears
  // in any other runId shape (Episode_/Test_/Special_/Manual_ are all flat),
  // so this check doesn't need the series folder to already exist on disk
  // (unlike the old existsSync-based check, which broke on day 1 of a brand
  // new series before any folder existed yet).
  if (/^Special_/.test(runId) || runId.includes('/')) return path.join('projects', 'Special', runId);
  const month = monthFolderFromRunId(runId);
  return month ? path.join('projects', month, runId) : path.join('projects', runId);
}

// Scans projects/ for both monthly subfolders and legacy top-level episode dirs.
function findAllProjects() {
  const results = [];
  const base = 'projects';
  for (const entry of fs.readdirSync(base)) {
    const fullPath = path.join(base, entry);
    if (!fs.statSync(fullPath).isDirectory()) continue;
    if (/^\d{4}_\d{2}_[A-Za-z]+$/.test(entry) || entry === 'Special') {
      for (const sub of fs.readdirSync(fullPath)) {
        const subPath = path.join(fullPath, sub);
        if (!fs.statSync(subPath).isDirectory()) continue;
        // Multi-day Special series: subPath is the series folder (no
        // state.json of its own) — the real per-day projects are one level
        // deeper, at Special/<Series>/<Day_N>/. Recurse only in that case;
        // a normal Special_N_YYYY_MM_DD project has state.json directly here.
        if (entry === 'Special' && !fs.existsSync(path.join(subPath, 'state.json'))) {
          for (const day of fs.readdirSync(subPath)) {
            const dayPath = path.join(subPath, day);
            if (fs.statSync(dayPath).isDirectory()) {
              results.push({ runId: `${sub}/${day}`, projectDir: dayPath, monthFolder: null });
            }
          }
        } else {
          results.push({ runId: sub, projectDir: subPath, monthFolder: entry === 'Special' ? null : entry });
        }
      }
    } else if (/^(Episode|Test|Special|Manual)_/.test(entry)) {
      results.push({ runId: entry, projectDir: fullPath, monthFolder: null });
    }
  }
  return results;
}

module.exports = { monthFolderFromRunId, getProjectDir, findAllProjects };
