'use strict';
const assert = require('assert');
const { buildHourWindows, hourRecencyWindows } = require('./select');

let failed = false;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failed = true; console.error(`  FAIL - ${name}\n    ${e.message}`); }
}

console.log('buildHourWindows');

test('N=24 returns no windows (recency disabled at the default window)', () => {
  assert.deepStrictEqual(buildHourWindows(24), []);
});

test('N<24 returns no windows', () => {
  assert.deepStrictEqual(buildHourWindows(12), []);
});

test('N=48 returns new + mid (mid truncated to [24,48)), no old', () => {
  const w = buildHourWindows(48);
  assert.strictEqual(w.length, 2);
  assert.deepStrictEqual(w[0], { minHoursAgo: 0, maxHoursAgo: 24, jcirlSlots: 15, gamingSlots: 8 });
  assert.deepStrictEqual(w[1], { minHoursAgo: 24, maxHoursAgo: 48, jcirlSlots: 10, gamingSlots: 5 });
});

test('N=72 returns new + full 48h mid, no old (boundary excluded)', () => {
  const w = buildHourWindows(72);
  assert.strictEqual(w.length, 2);
  assert.deepStrictEqual(w[1], { minHoursAgo: 24, maxHoursAgo: 72, jcirlSlots: 10, gamingSlots: 5 });
});

test('N=120 returns all three windows matching the spec example (48/48/24 -> 5/10/15)', () => {
  const w = buildHourWindows(120);
  assert.strictEqual(w.length, 3);
  assert.deepStrictEqual(w[0], { minHoursAgo: 0,  maxHoursAgo: 24,  jcirlSlots: 15, gamingSlots: 8 });
  assert.deepStrictEqual(w[1], { minHoursAgo: 24, maxHoursAgo: 72,  jcirlSlots: 10, gamingSlots: 5 });
  assert.deepStrictEqual(w[2], { minHoursAgo: 72, maxHoursAgo: 120, jcirlSlots: 5,  gamingSlots: 2 });
});

test('N=240 old window spans to N with the same fixed slot target', () => {
  const w = buildHourWindows(240);
  assert.strictEqual(w[2].maxHoursAgo, 240);
  assert.strictEqual(w[2].jcirlSlots, 5);
  assert.strictEqual(w[2].gamingSlots, 2);
});

console.log('hourRecencyWindows');

test('adds up to target slots per window, skips already-selected, ranks by view_count', () => {
  const now = Date.parse('2026-07-07T12:00:00Z');
  const hoursAgo = h => new Date(now - h * 3600000).toISOString();
  const pool = [
    { id: 'a', created_at: hoursAgo(1),  view_count: 50 },   // new window
    { id: 'b', created_at: hoursAgo(2),  view_count: 100 },  // new window, higher views
    { id: 'c', created_at: hoursAgo(30), view_count: 10 },   // mid window
    { id: 'd', created_at: hoursAgo(80), view_count: 5 },    // old window
  ];
  const windows = buildHourWindows(120);
  const picked = hourRecencyWindows(pool, [{ id: 'b' }], now, windows, 'jcirlSlots');
  const ids = picked.map(c => c.id);
  assert.ok(!ids.includes('b'), 'already-selected clip must be excluded');
  assert.ok(ids.includes('a'), 'new-window clip must be picked when b is excluded');
  assert.ok(ids.includes('c'), 'mid-window clip must be picked');
  assert.ok(ids.includes('d'), 'old-window clip must be picked');
});

test('caps at slot target even with more eligible clips in one window', () => {
  const now = Date.parse('2026-07-07T12:00:00Z');
  const hoursAgo = h => new Date(now - h * 3600000).toISOString();
  // 20 clips all in the "old" window (72-120h ago), which only targets 5 slots
  const pool = Array.from({ length: 20 }, (_, i) => ({
    id: `x${i}`, created_at: hoursAgo(80), view_count: 20 - i,
  }));
  const windows = buildHourWindows(120);
  const picked = hourRecencyWindows(pool, [], now, windows, 'jcirlSlots');
  assert.strictEqual(picked.length, 5);
  assert.strictEqual(picked[0].id, 'x0'); // highest view_count first
});

test('gamingSlots key uses the smaller gaming targets', () => {
  const now = Date.parse('2026-07-07T12:00:00Z');
  const hoursAgo = h => new Date(now - h * 3600000).toISOString();
  const pool = Array.from({ length: 20 }, (_, i) => ({
    id: `g${i}`, created_at: hoursAgo(1), view_count: 20 - i,
  }));
  const windows = buildHourWindows(120);
  const picked = hourRecencyWindows(pool, [], now, windows, 'gamingSlots');
  assert.strictEqual(picked.length, 8); // new window gamingSlots = 8
});

test('clip at exactly hoursAgo=24 lands in the mid window slot budget, not new (half-open seam)', () => {
  const now = Date.parse('2026-07-07T12:00:00Z');
  const hoursAgo = h => new Date(now - h * 3600000).toISOString();
  // New window (gamingSlots cap = 8): 7 fillers leave exactly one free slot for "y".
  const newFillers = Array.from({ length: 7 }, (_, i) => ({
    id: `n${i}`, created_at: hoursAgo(1), view_count: 100,
  }));
  const pool = [
    ...newFillers,
    { id: 'y', created_at: hoursAgo(2),  view_count: 50 },   // fills new window's last slot IF the seam is correct
    { id: 'x', created_at: hoursAgo(24), view_count: 9999 }, // exactly at the seam - must count toward mid, not new
    { id: 'z', created_at: hoursAgo(30), view_count: 1 },    // mid window filler
  ];
  const windows = buildHourWindows(120);
  const picked = hourRecencyWindows(pool, [], now, windows, 'gamingSlots');
  const ids = picked.map(c => c.id);
  // If x (hoursAgo===24) were mis-counted into the new window instead of mid, its huge
  // view_count would outrank and displace y out of new's 8-slot cap, and y would be lost
  // for good (mid never reconsiders a clip an earlier window's filter rejected).
  assert.ok(ids.includes('y'), 'y must survive in the new window; x must not have displaced it there');
  assert.ok(ids.includes('x'), 'x (exactly 24h ago) must still be picked, via the mid window');
  assert.ok(ids.includes('z'), 'z (mid window filler) must still get a slot');
  assert.strictEqual(picked.length, 10); // 7 new fillers + y + x + z
});

test('clip at exactly hoursAgo=72 lands in the old window slot budget, not mid (half-open seam)', () => {
  const now = Date.parse('2026-07-07T12:00:00Z');
  const hoursAgo = h => new Date(now - h * 3600000).toISOString();
  // Mid window (gamingSlots cap = 5): 4 fillers leave exactly one free slot for "y2".
  const midFillers = Array.from({ length: 4 }, (_, i) => ({
    id: `m${i}`, created_at: hoursAgo(30), view_count: 100,
  }));
  const pool = [
    ...midFillers,
    { id: 'y2', created_at: hoursAgo(40), view_count: 50 },   // fills mid window's last slot IF the seam is correct
    { id: 'x2', created_at: hoursAgo(72), view_count: 9999 }, // exactly at the seam - must count toward old, not mid
    { id: 'z2', created_at: hoursAgo(80), view_count: 1 },    // old window filler
  ];
  const windows = buildHourWindows(120);
  const picked = hourRecencyWindows(pool, [], now, windows, 'gamingSlots');
  const ids = picked.map(c => c.id);
  // If x2 (hoursAgo===72) were mis-counted into the mid window instead of old, its huge
  // view_count would outrank and displace y2 out of mid's 5-slot cap, and y2 would be
  // lost for good (old never reconsiders a clip an earlier window's filter rejected).
  assert.ok(ids.includes('y2'), 'y2 must survive in the mid window; x2 must not have displaced it there');
  assert.ok(ids.includes('x2'), 'x2 (exactly 72h ago) must still be picked, via the old window');
  assert.ok(ids.includes('z2'), 'z2 (old window filler) must still get a slot');
  assert.strictEqual(picked.length, 7); // 4 mid fillers + y2 + x2 + z2
});

if (failed) {
  console.error('\nSELECT TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nAll select.test.js checks passed.');
}
