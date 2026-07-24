# DDOS — Automated YouTube Video Pipeline

An autonomous content pipeline that turns raw Twitch clips into a fully edited,
published YouTube episode — long-form video, vertical Shorts, thumbnail, and
metadata — with a human only reviewing two checkpoints along the way.

Built as an agentic system on top of [Claude Code](https://claude.com/claude-code):
Claude orchestrates ~35 Node.js/Python scripts through a set of custom skills,
makes the editorial calls (clip selection, pacing, hooks, titles), and drives
everything end-to-end via natural-language commands.

## What it does

1. **Ingest** — pulls trending clips from the Twitch Helix API across a
   rotating set of game categories (Just Chatting, IRL, and the current
   top-trending games).
2. **Filter & select** — drops non-English content, gambling categories, and
   blacklisted channels; scores the remaining pool by popularity with a
   diversity floor so no single streamer dominates the episode.
3. **Download & screen** — fetches clips via `yt-dlp`, then samples one frame
   per gaming clip to auto-detect webcam/VTuber/tournament-HUD footage before
   it reaches the edit.
4. **Editorial pass** — generates an interactive HTML review board; a human
   (or Claude, reasoning over transcripts and scores) picks the final clip
   order, cuts, and groupings.
5. **Transcribe** — batch transcription via WhisperX (large-v3, GPU-accelerated)
   for captions and hook generation.
6. **Render** — FFmpeg-based trimming, loudness normalization, animated
   streamer-name overlays, and a full long-form concat render.
7. **Shorts** — automatically reframes selected moments into 1080×1920
   vertical clips with burned-in, word-level animated captions.
8. **Thumbnail & metadata** — Puppeteer-rendered thumbnail from a template,
   plus a generated title, description, tags, and chapter list.
9. **Publish** — uploads the episode and Shorts to YouTube via the Data API
   (OAuth2), on a schedule, once approved.

The whole flow runs autonomously from a single command; the only pauses are
a quick editorial review and a final upload approval.

## Architecture

```
Twitch API ──▶ filter ──▶ select ──▶ yt-dlp download ──▶ frame screening
                                                                │
                                                        editorial review (HTML UI)
                                                                │
                    WhisperX transcription ──▶ FFmpeg overlays/render ──▶ long-form MP4
                                                                │
                                            metadata + captions ──▶ vertical Shorts
                                                                │
                                                     thumbnail render ──▶ review page
                                                                │
                                                          YouTube upload
```

Each stage writes its state to a per-episode `state.json`, so any run can be
inspected, resumed, or retried from the point of failure.

## Tech stack

- **Orchestration:** Claude Code (agent skills + slash commands), Node.js
- **Video/audio:** FFmpeg (concat, loudness normalization, overlay compositing)
- **Rendering:** Puppeteer (HTML/CSS → overlays, thumbnails)
- **Transcription:** WhisperX (large-v3, CUDA) with optional vocal separation
- **APIs:** Twitch Helix, YouTube Data API v3

## Project structure

```
scripts/            pipeline stages (ingest, filter, download, render, publish…)
scripts/lib/         shared helpers (state, download, categories, timeline, audio)
.claude/skills/       Claude Code skills — one per pipeline stage
.claude/commands/     slash commands (/run, /ddos resume, /ddos approve …)
assets/               intro/outro clips, overlay templates, thumbnail template
brand/                content and tone-of-voice guidelines
projects/             per-episode output (git-ignored — generated content)
```

## Notes

This is a personal production system tied to a specific YouTube channel and
Twitch API credentials — it isn't packaged for drop-in reuse. It's shared here
as a portfolio example of building a multi-stage, agent-driven media pipeline:
API integration, batch GPU transcription, programmatic video composition, and
LLM-in-the-loop editorial decision-making, all coordinated through Claude Code.
