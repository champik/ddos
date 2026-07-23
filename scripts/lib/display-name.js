'use strict';

// Extracts broadcaster_login from Twitch clip URL (https://www.twitch.tv/{login}/clip/{id})
function loginFromUrl(url) {
  if (!url) return null;
  try { return new URL(url).pathname.split('/').filter(Boolean)[0] || null; }
  catch { return null; }
}

// Returns broadcaster_login for a clip (prefers stored field, falls back to URL parse)
function getLogin(clip) {
  return clip.broadcaster_login || loginFromUrl(clip.url) || null;
}

// True if name contains non-ASCII characters (e.g. Korean, Japanese, Chinese, Arabic)
function isNonAscii(name) {
  return name ? !/^[\x00-\x7F]*$/.test(name) : false;
}

// Display name for overlays / descriptions:
// ASCII names → unchanged; non-ASCII → "DisplayName (login)"
function streamerDisplayName(clip) {
  const name = clip.broadcaster_name || '';
  if (!isNonAscii(name)) return name;
  const login = getLogin(clip);
  return login ? `${name} (${login})` : name;
}

// Tag/hashtag name: use login for non-ASCII (searchable), broadcaster_name for ASCII
function streamerTag(clip) {
  const name = clip.broadcaster_name || '';
  if (!isNonAscii(name)) return name;
  return getLogin(clip) || name;
}

module.exports = { streamerDisplayName, streamerTag, loginFromUrl, getLogin, isNonAscii };
