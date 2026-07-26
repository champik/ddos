'use strict';
const assert = require('assert');
const { normalizeWord, isProfane, maskWord } = require('./profanity');

let failed = false;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failed = true; console.error(`  FAIL - ${name}\n    ${e.message}`); }
}

console.log('normalizeWord');

test('lowercases and strips punctuation', () => {
  assert.strictEqual(normalizeWord('Shit!'), 'shit');
  assert.strictEqual(normalizeWord('  Fuck,'), 'fuck');
});

test('keeps apostrophes', () => {
  assert.strictEqual(normalizeWord("Y'all"), "y'all");
});

console.log('isProfane');

test('matches Tier 1 words', () => {
  assert.strictEqual(isProfane('fuck'), true);
  assert.strictEqual(isProfane('Fucking'), true);
  assert.strictEqual(isProfane('shit.'), true);
  assert.strictEqual(isProfane('bitch,'), true);
});

test('matches Tier 2 slurs', () => {
  assert.strictEqual(isProfane('nigga'), true);
  assert.strictEqual(isProfane('faggot'), true);
  assert.strictEqual(isProfane('retarded'), true);
});

test('does not match mild Tier 3 words (excluded by design)', () => {
  assert.strictEqual(isProfane('damn'), false);
  assert.strictEqual(isProfane('hell'), false);
  assert.strictEqual(isProfane('crap'), false);
});

test('does not substring-match inside innocent words', () => {
  assert.strictEqual(isProfane('assume'), false);
  assert.strictEqual(isProfane('class'), false);
  assert.strictEqual(isProfane('assist'), false);
  assert.strictEqual(isProfane('grass'), false);
});

test('everyday words are not flagged', () => {
  assert.strictEqual(isProfane('hello'), false);
  assert.strictEqual(isProfane('the'), false);
});

console.log('maskWord');

test('keeps first/last letter, masks the middle', () => {
  assert.strictEqual(maskWord('fuck'), 'f**k');
  assert.strictEqual(maskWord('shit'), 's**t');
  assert.strictEqual(maskWord('bitch'), 'b***h');
  assert.strictEqual(maskWord('ass'), 'a*s');
});

test('preserves original casing and trailing punctuation', () => {
  assert.strictEqual(maskWord('Fuck,'), 'F**k,');
  assert.strictEqual(maskWord('SHIT!'), 'S**T!');
});

test('leaves 2-letter-or-shorter tokens untouched (no profanity word is this short, but must not crash)', () => {
  assert.strictEqual(maskWord('hi'), 'hi');
  assert.strictEqual(maskWord('a'), 'a');
});

if (failed) {
  console.error('\nPROFANITY TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nAll profanity.test.js checks passed.');
}
