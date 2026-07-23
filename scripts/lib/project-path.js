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
  if (/^Special_/.test(runId)) return path.join('projects', 'Special', runId);
  const specialPath = path.join('projects', 'Special', runId);
  if (fs.existsSync(specialPath)) return specialPath;
  // Multi-day Special series ("<SeriesName>/Day_N"): the series folder may
  // already exist even when this particular day's folder doesn't yet.
  const topSegment = runId.split('/')[0];
  if (topSegment !== runId && fs.existsSync(path.join('projects', 'Special', topSegment))) {
    return specialPath;
  }
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
        if (fs.statSync(subPath).isDirectory()) {
          results.push({ runId: sub, projectDir: subPath, monthFolder: entry });
        }
      }
    } else if (/^(Episode|Test|Special|Manual)_/.test(entry)) {
      results.push({ runId: entry, projectDir: fullPath, monthFolder: null });
    }
  }
  return results;
}

module.exports = { monthFolderFromRunId, getProjectDir, findAllProjects };
