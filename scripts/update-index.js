#!/usr/bin/env node
// Update an episode card in projects/index.html after publish
const fs = require('fs');
const path = require('path');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node scripts/update-index.js <runId>'); process.exit(1); }

const state = JSON.parse(fs.readFileSync(path.join('projects', runId, 'state.json'), 'utf8'));
const ep = state.episodeNumber;
const editExists = fs.existsSync(path.join('projects', runId, 'edit/edit.html'));

const indexPath = 'projects/index.html';
let html = fs.readFileSync(indexPath, 'utf8');

const links = [
  `<a class="btn btn-review" href="${runId}/review/review.html">Review</a>`,
  editExists ? `<a class="btn btn-edit" href="${runId}/edit/edit.html">✏️ Edit</a>` : null,
].filter(Boolean);

const newLinksRow = links.map(l => `      ${l}`).join('\n');

// Isolate the EPISODE N section (from comment to next comment or </body>)
const sectionRe = new RegExp(`(<!-- EPISODE ${ep} -->)([\\s\\S]*?)(?=<!-- EPISODE|<\\/body>)`);

const updated = html.replace(sectionRe, (match, marker, block) => {
  block = block.replace(
    /class="status-(?:pending|published)">[^<]*<\/span>/,
    'class="status-published">✓ published</span>'
  );
  block = block.replace(
    /(<div class="links-row">)[\s\S]*?(<\/div>)/,
    `$1\n${newLinksRow}\n    $2`
  );
  return marker + block;
});

if (updated === html) {
  console.error(`[INDEX] Episode #${ep} section not found in index.html`);
  process.exit(1);
}

fs.writeFileSync(indexPath, updated);
console.log(`[INDEX] ✓ Updated Episode #${ep} (${runId})`);
if (editExists) console.log(`  Edit link added`);
