'use strict';
// profanity.js — single source of truth for profanity detection + masking.
// Used by scripts/apply-censor.js (audio mute) and scripts/gen-captions.js
// (caption text masking) so the two never drift out of sync.
//
// Tier 1 (hard profanity) + Tier 2 (slurs) only — mild words (damn/hell/crap)
// are deliberately excluded: by themselves they rarely trigger YouTube
// demonetization, and muting them on every use would make videos feel
// choppy without cause. See docs/superpowers/specs/2026-07-26-profanity-censorship-design.md.

const TIER1 = [
  'fuck', 'fucking', 'fucked', 'fucker', 'fuckers', 'motherfucker', 'motherfucking',
  'fuk', 'fck', 'shit', 'shitty', 'bullshit', 'horseshit', 'cunt', 'cunts',
  'dick', 'dicks', 'pussy', 'whore', 'whores', 'slut', 'sluts', 'cum',
  'asshole', 'assholes', 'bitch', 'bitches', 'bitchy', 'bastard', 'bastards',
  'cock', 'cocks',
];

const TIER2 = [
  'nigger', 'nigga', 'niggas', 'faggot', 'fag', 'faggots', 'retard', 'retarded',
  'tranny', 'chink', 'spic', 'gook', 'kike',
];

const PROFANITY_WORDS = new Set([...TIER1, ...TIER2]);

function normalizeWord(w) {
  return String(w || '').trim().toLowerCase().replace(/[^a-z']/g, '');
}

function isProfane(word) {
  return PROFANITY_WORDS.has(normalizeWord(word));
}

// Keeps the letters at both ends, masks everything between with '*'.
// Operates on the original token so surrounding punctuation ("shit,") and
// casing ("SHIT") are preserved — only the letter run itself gets masked.
function maskWord(rawWord) {
  const str = String(rawWord || '');
  const m = str.match(/^([^a-zA-Z']*)([a-zA-Z']+)([^a-zA-Z']*)$/);
  if (!m) return str;
  const [, lead, letters, trail] = m;
  if (letters.length <= 2) return str;
  const masked = letters[0] + '*'.repeat(letters.length - 2) + letters[letters.length - 1];
  return lead + masked + trail;
}

module.exports = { PROFANITY_WORDS, normalizeWord, isProfane, maskWord };
