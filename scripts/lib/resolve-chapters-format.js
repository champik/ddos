'use strict';
// resolve-chapters-format.js — pure formatter for exports/chapters.txt.
// Input: ordered list of already-matched content clips read off the Resolve
// timeline ({ basename, startSeconds, streamerName }) — filtering out intro/
// outro/reconnecting/manual inserts already happened upstream (resolve_ctl.py
// chapters + resolve-chapters.js). Output: display lines ("m:ss Name").
//
// Two rules, both agreed with the user ahead of implementation:
// - consecutive clips by the same streamer merge into one line (matches
//   buildChapters() in lib/timeline.js, the old auto-render pipeline's
//   equivalent);
// - the first line is always "0:00" — YouTube requires the first chapter to
//   start there, so every timestamp is shown relative to the first matched
//   clip, not to the timeline's real (post-intro) start.

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatChapterLines(items) {
  if (!items || items.length === 0) return [];

  const offset = items[0].startSeconds;
  const lines = [];
  let lastStreamer = null;

  for (const item of items) {
    if (item.streamerName === lastStreamer) continue;
    lines.push(`${formatTimestamp(item.startSeconds - offset)} ${item.streamerName}`);
    lastStreamer = item.streamerName;
  }

  return lines;
}

module.exports = { formatChapterLines, formatTimestamp };
