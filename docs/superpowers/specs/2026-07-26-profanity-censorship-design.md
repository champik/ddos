# Profanity muting + captions masking

## Problem

Strong profanity in episode audio (and in shorts, which reuse the same audio)
is suspected to hurt YouTube algorithmic promotion/monetization. There is
currently no profanity detection, muting, or caption-censorship anywhere in
the pipeline — `gen-captions.js` has a `HOT` word list (L27-29) but it only
drives *visual emphasis* (uppercase + scale-pop) for emotionally loud words,
not censorship, and it will be removed as part of this change.

Goal: automatically detect profane words from the already-existing
word-level transcript, mute them in the final audio and replace the gap with
`assets/sounds/glitch.wav`, mask the same words in shorts captions
(`f**k` style), and give the editor a manual override in `edit.html` for
words the automatic detector misses.

## Non-goals

- No per-word manual review UI beyond the existing review.html Tags column
  (no new page/section).
- No vocal-stem isolation (demucs) at censor time — mute affects the full
  mixed clip audio for the word's duration, same as a standard TV bleep. The
  `vocals_rms`/demucs machinery in `transcribe-batch.py` is used only for
  transcription accuracy and loud-word caption emphasis; it is not touched.
- No configurable/per-episode toggle — censorship always runs for every
  episode and every selected clip.
- No changes to long-form episode captions — the episode has no burned-in
  captions today; only shorts do (`captions-vertical.ass`).

## Word list

`scripts/lib/profanity.js` (new) owns a single hardcoded list — Tier 1 (hard
profanity) + Tier 2 (slurs), per explicit user decision to exclude mild words
(damn/hell/crap/ass) since those alone rarely trigger demonetization and
constant muting of them would make videos feel choppy without cause:

```
Tier 1: fuck, fucking, fucked, fucker, fuckers, motherfucker, motherfucking,
        fuk, fck, shit, shitty, bullshit, horseshit, cunt, cunts, dick,
        dicks, pussy, whore, whores, slut, sluts, cum, asshole, assholes,
        bitch, bitches, bitchy, bastard, bastards, cock, cocks
Tier 2: nigger, nigga, niggas, faggot, fag, faggots, retard, retarded,
        tranny, chink, spic, gook, kike
```

Exports:
- `normalizeWord(w)` — lowercase, strip everything but `[a-z']`
- `isProfane(word)` — exact match against the normalized set (no
  prefix/substring matching — `ass` must never match inside `assume`)
- `maskWord(word)` — first + last character kept, middle replaced with `*`
  repeated `word.length - 2` times (e.g. `fuck` → `f**k`, `bitch` → `b***h`).
  Applied to the original token so casing/trailing punctuation captured by
  WhisperX is preserved on the two visible characters.

This module is the single source of truth, imported by both the audio-mute
script and the captions generator — no duplicated word lists.

## Pipeline placement

New stage **8b. CENSOR**, inserted between TRANSCRIBE (8) and OVERLAYS (9) in
Stage 2 (`CLAUDE.md` pipeline list gets renumbered accordingly, mirroring how
`7b. EXTRACT_FRAMES` is already slotted between APPLY_EDITORIAL and
TRANSCRIBE).

This is the only correct placement: `transcript.json` is generated **from**
`clean.mp4` (post-trim, post-VOD-replace), so word timestamps already line up
1:1 with `clean.mp4`'s timeline — no time remapping needed. Placing it any
earlier (e.g. inside `apply-editorial.js`) is impossible because the
transcript doesn't exist yet at that point.

New script `scripts/apply-censor.js` (naming mirrors `apply-editorial.js` /
`apply-overlays.js`, both of which similarly mutate `processed/<clipId>/`
outputs in place), run per selected clip after transcription:

1. Read `processed/<clipId>/transcript.json` words[] and
   `edit/editorial.json` clip state for `manualMutes` (see below).
2. Build the mute-window list:
   - **Auto-detected**: for every word where `isProfane(normalizeWord(word.word))`,
     window = `[word.start, word.end]` padded by 40ms on each side, clamped
     so it never crosses into the previous/next word's span. Applies
     regardless of `interp`/`retimed` flags (per explicit decision — timing
     is close enough, and silently skipping risks profanity reaching the
     published video, which is the worse failure mode).
   - **Manual**: for every entry in `cs.manualMutes` (see edit.html section),
     window = `[at, at + glitchDuration]` where `glitchDuration` is the
     probed duration of `assets/sounds/glitch.wav` (currently ~0.51s after
     the earlier trim-silence pass), clamped to clip duration.
3. For each window, in one ffmpeg pass on `clean.mp4`:
   - Mute original audio: `volume=0:enable='between(t,s1,e1)+between(t,s2,e2)+...'`
   - Mix in `assets/sounds/glitch.wav` trimmed to exactly the window's
     duration (`-t <windowDuration>`) via `amovie`+`adelay`+`amix`, so the
     glitch sound never bleeds past the muted word into adjacent speech.
   - `-c:v copy` (video untouched, audio-only filter graph) — fast, no
     quality loss on the video stream.
4. Overwrite `clean.mp4` in place. Because every downstream stage
   (`apply-overlays.js` → `overlayed.mp4`, `build-concat.js`, and
   `render-shorts.js`, which reads `clean.mp4` directly) already just reads
   whatever audio is in `clean.mp4`, **no downstream script needs to
   change** — this is why in-place mutation was chosen over a new output
   file.
5. Write `processed/<clipId>/censor-log.json`:
   ```json
   [{ "word": "fuck", "masked": "f**k", "start": 12.34, "end": 12.61, "source": "auto" }]
   ```
   (`source: "manual"` for editor-added marks.) Empty array if nothing
   matched — still written, so caching (next point) has something to hash.
6. Caching: `processed/<clipId>/censor-hash.txt` — hash of (word list
   version + matched word timestamps + manualMutes). On `/ddos resume`, skip
   re-encoding a clip whose hash is unchanged, consistent with the existing
   `edit-hash.txt` pattern.

Errors on an individual clip's ffmpeg pass: `stages.censor = 'done_with_errors'`
+ entry in `state.warnings`, pipeline continues (consistent with existing
audio-check failure handling described in `CLAUDE.md`).

## Captions masking (`gen-captions.js`)

- Remove the `HOT` word list and its uppercase/emphasis logic entirely (per
  explicit instruction — it targeted the wrong thing).
- In `buildKaraokeText()`, for each word: if `isProfane(normalizeWord(word.word))`,
  render `maskWord(word.word)` instead of the real text.
- The existing RMS-based loud-word scale-pop (`isLoudAt`/`isProminentAt`,
  independent feature) is untouched and can still fire on a masked word if it
  was spoken loudly — the two features are orthogonal.
- Shorts reuse `clean.mp4` (now censored) and `captions-vertical.ass` (now
  masked) — no separate shorts-specific work needed.

## Manual override: Mute button in `edit.html`

Added to the existing tag row (`ctrl-row` alongside Recon/Thumb/Short/VOD),
as a new `🔇 Mute` button. Unlike Recon/Thumb/Short/VOD — which are
single-value **toggles** per clip (`cs.short`, thumbnails entry,
`state.reconnects[clipId]`, `cs.subtitle`) — Mute is an **action** button
that always **adds** a new timestamp mark at the video's current
`currentTime`, because a clip can contain more than one missed curse word.
This mirrors the existing "+" (`addCut`) pattern rather than a toggle
pattern.

- State: `cs.manualMutes = [{ at: 12.34 }, ...]` (per-clip array, mirrors
  `cs.keeps` structurally).
- Display: a small removable list under the tag row, same visual pattern as
  `cuts-list` (`🔇 0:12.3` + `×` to remove), so multiple marks are visible
  and manageable without a new tab.
- No new play-mode tab is created (unlike Thumb/Shorts, which reveal
  Thumbnail/Shorts preview tabs) — per explicit instruction, it behaves like
  the VOD button: a plain marker, nothing more.
- Serialized into `editorial.json` per clip (alongside `keeps`, `short`,
  etc.) so `apply-censor.js` can read it in Stage 2.
- The existing `CC` button is renamed to `VOD` (label text only — internal
  `tag-subtitle`/`cs.subtitle`/`toggleTag('subtitle')` identifiers are
  unchanged, since they already serialize to `editorial.vodClipIds` and
  every other visible badge already reads "VOD"; only the clickable button
  itself still said "CC").

## review.html — Tags column (no new section)

In the existing Clips table, `gen-review.js`'s Tags-cell builder (L103-116)
gets one more entry, following the existing badge style
(`SHORT:MODE`, `THUMB`, `✂N`, `VOD`): for each clip with a non-empty
`censor-log.json`, render one compact badge per censored instance, e.g.
`🔇 shit@12.3s`, `🔇 fuck@45.1s` — word + masked form implied by the icon,
second precision matches other timing displays in review.html.

## Testing

- `scripts/lib/profanity.test.js` (new, mirrors existing `select.test.js`/
  `timeline.test.js` pattern): `normalizeWord`/`isProfane` false-positive
  cases (`assume`, `class`, `hello` must not match) and `maskWord` output
  for known words.
- Manual verification pass on one real episode: confirm `censor-log.json`
  entries line up with audible mutes in the rendered episode, and that
  masked captions match in the rendered short.
