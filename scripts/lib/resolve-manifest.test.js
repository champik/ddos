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
