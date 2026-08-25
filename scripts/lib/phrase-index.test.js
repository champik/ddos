'use strict';
const assert = require('assert');
const { wordsToSegments, buildPhraseEntry, mergePhraseEntries } = require('./phrase-index');

let failed = false;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failed = true; console.error(`  FAIL - ${name}\n    ${e.message}`); }
}

console.log('wordsToSegments');

test('groups consecutive words by seg index into {text,start,end}', () => {
  const words = [
    { word: 'hello', start: 0.0, end: 0.3, seg: 0 },
    { word: 'there', start: 0.3, end: 0.6, seg: 0 },
    { word: 'general', start: 1.0, end: 1.4, seg: 1 },
    { word: 'kenobi', start: 1.4, end: 1.9, seg: 1 },
  ];
  const segs = wordsToSegments(words);
  assert.strictEqual(segs.length, 2);
  assert.deepStrictEqual(segs[0], { text: 'hello there', start: 0.0, end: 0.6 });
  assert.deepStrictEqual(segs[1], { text: 'general kenobi', start: 1.0, end: 1.9 });
});

test('empty words returns empty segments', () => {
  assert.deepStrictEqual(wordsToSegments([]), []);
  assert.deepStrictEqual(wordsToSegments(undefined), []);
});

console.log('buildPhraseEntry');

test('builds entry from clip metadata + transcript', () => {
  const clip = { id: 'abc123', url: 'https://clips.twitch.tv/abc123', title: 'W Clip', view_count: 5000, created_at: '2026-05-15T10:00:00Z' };
  const transcript = {
    clip_id: 'abc123', text: 'hello there',
    words: [
      { word: 'hello', start: 0.0, end: 0.3, seg: 0 },
      { word: 'there', start: 0.3, end: 0.6, seg: 0 },
    ],
  };
  const entry = buildPhraseEntry(clip, transcript);
  assert.strictEqual(entry.clipId, 'abc123');
  assert.strictEqual(entry.url, 'https://clips.twitch.tv/abc123');
  assert.strictEqual(entry.views, 5000);
  assert.strictEqual(entry.date, '2026-05-15');
  assert.deepStrictEqual(entry.segments, [{ text: 'hello there', start: 0.0, end: 0.6 }]);
});

test('returns null for a failed transcription', () => {
  const clip = { id: 'x', url: 'u', title: 't', view_count: 1, created_at: '2026-01-01T00:00:00Z' };
  assert.strictEqual(buildPhraseEntry(clip, { clip_id: 'x', error: 'boom' }), null);
  assert.strictEqual(buildPhraseEntry(clip, null), null);
});

console.log('mergePhraseEntries');

test('dedupes by clipId, existing entries win', () => {
  const existing = [{ clipId: 'a', title: 'old' }];
  const merged = mergePhraseEntries(existing, [{ clipId: 'a', title: 'new' }, { clipId: 'b', title: 'fresh' }]);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged.find(e => e.clipId === 'a').title, 'old');
  assert.strictEqual(merged.find(e => e.clipId === 'b').title, 'fresh');
});

test('skips null entries from failed transcriptions', () => {
  const merged = mergePhraseEntries([], [null, { clipId: 'a' }, null]);
  assert.deepStrictEqual(merged, [{ clipId: 'a' }]);
});

console.log(failed ? '\nSome tests FAILED' : '\nAll tests passed');
if (failed) process.exit(1);
