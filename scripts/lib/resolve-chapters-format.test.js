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
