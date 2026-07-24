'use strict';
const assert = require('assert');
const { editorialSegments, mapToCleanTimeline } = require('./timeline');

let failed = false;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failed = true; console.error(`  FAIL - ${name}\n    ${e.message}`); }
}

console.log('editorialSegments');

test('no keeps → single [in, out] segment', () => {
  assert.deepStrictEqual(editorialSegments(null, 2, 10), [[2, 10]]);
});

test('keeps are clipped to trim bounds', () => {
  assert.deepStrictEqual(editorialSegments([[0, 5], [8, 20]], 2, 15), [[2, 5], [8, 15]]);
});

test('keeps fully outside trim are dropped', () => {
  assert.deepStrictEqual(editorialSegments([[0, 1], [8, 12]], 5, 20), [[8, 12]]);
});

console.log('mapToCleanTimeline');

test('no keeps → shifted by trim.in', () => {
  assert.strictEqual(mapToCleanTimeline(12, null, 5, 30), 7);
});

test('no trim, no keeps → identity', () => {
  assert.strictEqual(mapToCleanTimeline(12, null), 12);
});

test('inside first keep', () => {
  assert.strictEqual(mapToCleanTimeline(3, [[2, 6], [10, 14]], 0, 60), 1);
});

test('inside second keep → preceding keep durations accumulate', () => {
  // keep1 = 4s, момент на 2s всередині keep2 → 4 + 2 = 6
  assert.strictEqual(mapToCleanTimeline(12, [[2, 6], [10, 14]], 0, 60), 6);
});

// Регресія: саме цей випадок робив порожню перебивку. reconnectSource.from
// лишився на старому місці, keeps зсунулись — момент опинився у вирізаному.
// Раніше повертався кінець останнього keep (= кінець clean.mp4), і ffmpeg
// віддавав нульову перебивку з кодом 0.
test('timestamp in a cut-out gap → null, not end-of-file', () => {
  assert.strictEqual(mapToCleanTimeline(8, [[2, 6], [10, 14]], 0, 60), null);
});

test('timestamp past the last keep → null', () => {
  assert.strictEqual(mapToCleanTimeline(50, [[2, 6], [10, 14]], 0, 60), null);
});

test('timestamp before trim.in → null', () => {
  assert.strictEqual(mapToCleanTimeline(1, null, 5, 30), null);
});

test('timestamp past trim.out → null', () => {
  assert.strictEqual(mapToCleanTimeline(40, null, 5, 30), null);
});

test('keep boundaries are inclusive', () => {
  assert.strictEqual(mapToCleanTimeline(2, [[2, 6]], 0, 60), 0);
  assert.strictEqual(mapToCleanTimeline(6, [[2, 6]], 0, 60), 4);
});

if (failed) process.exit(1);
console.log('\nAll timeline tests passed.');
