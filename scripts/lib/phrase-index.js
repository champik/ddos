'use strict';
// phrase-index.js — pure helpers for building/merging candidates/<streamer>/phrases.json
// from Whisper transcript output (scripts/transcribe-batch.py). No I/O here — callers
// (streamer-phrase-index.js) own file reads/writes so this stays unit-testable.

// transcribe-batch.py's output has word-level timestamps with a `seg` index
// linking each word back to its original Whisper segment, but no explicit
// segment-level {text, start, end} list. Rebuild one — phrase search matches
// against segment-length chunks, not individual words.
function wordsToSegments(words) {
  const segments = [];
  let current = null;
  for (const w of (words || [])) {
    if (!current || current.seg !== w.seg) {
      current = { seg: w.seg, start: w.start, end: w.end, words: [w.word] };
      segments.push(current);
    } else {
      current.end = w.end;
      current.words.push(w.word);
    }
  }
  return segments.map(s => ({ text: s.words.join(' ').trim(), start: s.start, end: s.end }));
}

// clipMeta: raw Twitch clip object (id, url, title, view_count, created_at).
// transcript: transcribe-batch.py output ({clip_id, text, words, error?}).
// Returns null for failed transcriptions — caller skips them rather than
// polluting the phrase index with empty entries.
function buildPhraseEntry(clipMeta, transcript) {
  if (!transcript || transcript.error) return null;
  return {
    clipId: clipMeta.id,
    url: clipMeta.url,
    title: clipMeta.title || '',
    views: clipMeta.view_count || 0,
    date: (clipMeta.created_at || '').slice(0, 10),
    segments: wordsToSegments(transcript.words),
  };
}

// Dedupe-merge by clipId, existing entries win (re-running never overwrites
// already-indexed clips — matches the "skip cached" pattern used across the
// rest of the pipeline, e.g. transcribe-batch.js).
function mergePhraseEntries(existing, newEntries) {
  const byId = new Map((existing || []).map(e => [e.clipId, e]));
  for (const entry of (newEntries || [])) {
    if (entry && !byId.has(entry.clipId)) byId.set(entry.clipId, entry);
  }
  return [...byId.values()];
}

module.exports = { wordsToSegments, buildPhraseEntry, mergePhraseEntries };
