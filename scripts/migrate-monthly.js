#!/usr/bin/env node
'use strict';
// One-time migration: move episode folders into monthly subfolders,
// update projects/index.html paths and add month section headers.
const fs   = require('fs');
const path = require('path');

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

function monthFolderFromRunId(runId) {
  const m = runId.match(/_(\d{4})_(\d{2})_\d{2}$/);
  if (!m) return null;
  return `${m[1]}_${MONTH_NAMES[parseInt(m[2], 10) - 1]}`;
}

const base = 'projects';

// 1. Find all episode-like dirs directly in projects/
const entries = fs.readdirSync(base).filter(e => {
  const p = path.join(base, e);
  return fs.statSync(p).isDirectory() && /^(Episode|Test|Special|Manual)_/.test(e);
});

if (!entries.length) {
  console.log('Nothing to migrate — no top-level episode folders found.');
  process.exit(0);
}
console.log(`Found ${entries.length} folders to migrate.\n`);

// 2. Group by month
const byMonth = {};
for (const e of entries) {
  const month = monthFolderFromRunId(e) || 'unknown';
  if (!byMonth[month]) byMonth[month] = [];
  byMonth[month].push(e);
}

// 3. Move folders
for (const [month, dirs] of Object.entries(byMonth)) {
  const monthPath = path.join(base, month);
  fs.mkdirSync(monthPath, { recursive: true });
  for (const dir of dirs) {
    const src = path.join(base, dir);
    const dst = path.join(monthPath, dir);
    fs.renameSync(src, dst);
    console.log(`  ${dir}  →  ${month}/${dir}`);
  }
}

// 4. Update index.html
const indexPath = path.join(base, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');

// 4a. Update href/src paths: Episode_N_YYYY_MM_DD/ → YYYY_MonthName/Episode_N_YYYY_MM_DD/
html = html.replace(
  /(href|src)="((?:Episode|Test|Special|Manual)_\d+_(\d{4})_(\d{2})_\d{2})(\/?)/g,
  (match, attr, runId, year, mm, slash) => {
    const monthName = MONTH_NAMES[parseInt(mm, 10) - 1];
    return `${attr}="${year}_${monthName}/${runId}${slash}`;
  }
);

// 4b. Add month-header CSS (before </style>)
if (!html.includes('.month-header')) {
  html = html.replace('</style>', `.month-header {
  font-family: 'Anton', sans-serif;
  font-size: 20px;
  color: #444;
  letter-spacing: 2px;
  text-transform: uppercase;
  margin: 32px 0 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #1e1e22;
}
</style>`);
}

// 4c. Insert month headers before the highest-numbered episode in each month
// Sort months newest-first by their max episode number
const monthToMax = {};
for (const [month, dirs] of Object.entries(byMonth)) {
  if (month === 'unknown') continue;
  const nums = dirs.map(d => {
    const m = d.match(/^(?:Episode|Test|Special|Manual)_(\d+)_/);
    return m ? parseInt(m[1]) : 0;
  });
  monthToMax[month] = Math.max(...nums);
}

const sortedMonths = Object.entries(monthToMax)
  .sort(([, a], [, b]) => b - a); // newest month first

for (const [month, maxEp] of sortedMonths) {
  const [year, monthName] = month.split('_');
  const header = `<h2 class="month-header">${monthName} ${year}</h2>\n`;
  const marker = `<!-- EPISODE ${maxEp} -->`;
  if (html.includes(marker) && !html.includes(`${header}${marker}`)) {
    html = html.replace(marker, `${header}${marker}`);
  }
}

fs.writeFileSync(indexPath, html);
console.log('\n✓ index.html updated with month headers and new paths.');
console.log('✓ Migration complete.\n');
