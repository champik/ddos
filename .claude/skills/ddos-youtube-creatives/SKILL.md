---
name: ddos-youtube-creatives
description: Use when generating YouTube titles, thumbnail hooks, tags, or hashtags for a DDOS episode — applies retention-first marketing framework to all creative assets
---

# Skill: ddos-youtube-creatives

Генерація YouTube-креативів для DDOS епізоду: назви, текст на обкладинці, теги, хештеги. Опис
користувач пише сам у YouTube Studio (фінальний монтаж — CapCut, система його не бачить);
субтитри для Shorts також робить CapCut.

Фреймворк: retention-first marketing — psychological trigger titles, mobile-first thumbnails, шортси title/hashtags для search & discovery.

## Метрики успіху (цілі)

| Метрика | Ціль |
|---------|------|
| CTR | ≥ 8% |
| Retention на 3-хв. позначці | ≥ 50% |
| Views-to-subscriber | ≥ 1% |
| Algorithmically suggested traffic | +40% |

---

## Stage 12 — запуск

**Selection-only pipeline:** фінальний рендер (long-form + Shorts) відбувається в CapCut, система
більше нічого не рендерить після METADATA/THUMBNAIL/REVIEW —
див. `docs/superpowers/specs/2026-08-02-capcut-handoff-design.md`. `description` більше не
генерується (користувач пише опис сам у YouTube Studio), `shortIntros` прибрано (нікому вже не
потрібен — RENDER SHORTS в системі не викликається).

```bash
node scripts/progress.js "<projectDir>" 12 "YouTube metadata (Claude)"
```

Перед генерацією промпту зчитати дані автоматично:
1. `edit/episode-plan.json` → список кліпів в порядку відео + `shortClipIds`
2. `clips/scored-clips.json` → `broadcaster_name`, `title`, `view_count`, `game_name` по кожному clipId
3. `edit/editorial.json` → `thumbnails` array (список clipId для яких потрібні `thumbnailHooks`)
4. Для кожного кліпу з `clipOrder`:
   - basename кожного clipId — `buildBasenameMap(editorial.clipOrder, downloaded-clips.json)` з
     `scripts/lib/clip-naming.js` (NN_streamer_idSuffix, той самий порядок що й у `clipOrder`)
   - `processed/transcripts/<basename>.json` → `text` (повний, без обрізки)
   - Якщо transcript відсутній → `""` (порожній рядок)
   - EXTRACT_FRAMES вимкнено (не викликається) — кадрів більше нема, працювати лише з transcript
5. Для кліпів з `shortClipIds` — передати повний transcript окремо у `shortsTranscripts`

Передай Claude список кліпів:

```
You are a YouTube video optimization specialist for "Daily Dose Of Stream" (DDOS) — a daily Twitch clip digest channel (funny, comfortable, curated). English-speaking audience.

Framework:
- Retention-first: the first 30 seconds determine watch-through. Titles and thumbnails must hook without deception.
- Thumbnails tell micro-stories. Mobile-first: readable at 200px width.
- Google & AI Overviews: YouTube is core Google search infrastructure. Long-form clips compilations (12-15 min) dominate AI citation (94% of cited videos).
- Base every hook on the transcript — the spoken words are the only source of truth here (no keyframes available at this step). Never invent details absent from it.

Episode data:
  Episode #: <N>
  Clips (in order):
  [clipId] streamer | category | clip title
  Transcript: "<full transcript text or 'no transcript'>"
  ---
  (repeat for each clip)

  Shorts:
  [clipId] streamer | game/category | clip title
  Transcript: "<full transcript>"
  ---
  (repeat for each short)

  Thumbnail clips (need thumbnailHooks): <comma-separated list of clipIds from editorial.thumbnails>

  Recognizable streamers (universally famous — xQc, Kai Cenat, HAchubby тощо): <comma-separated list, or "none">

Respond ONLY with valid JSON, no markdown:
{
  "clipHooks": [
    {"clipId": "<id>", "hook": "<StreamerName Action/Event — max 60 chars>"}
  ],
  "thumbnailHooks": [
    {"clipId": "<id>", "hook": "<2-4 WORDS ALL CAPS>"}
  ],
  "thumbnailStrategy": "<One sentence: which transcript moment to build the thumbnail image around, what emotion/action it implies, why it works at mobile size.>",
  "shortsMetadata": [
    {
      "clipId": "<id>",
      "title": "<max 60 chars — see shortsMetadata Title rules>",
      "description": "<50-80 words — see shortsMetadata Description rules>",
      "hashtags": ["#DailyDoseOfStream","#TwitchClips","#<streamer>"]
    }
  ]
}

clipHooks rules — HARD CONSTRAINTS:
- Include ONLY clips with a genuinely strong, shareable moment: viral action, hype event, surprising outcome, famous streamer milestone
- No fixed count — judge purely on clip quality; weak clips get no hook
- Format: StreamerName + 2-3 words that label the moment — reads like a newspaper slug, NOT a full sentence. Past-tense verbs are welcome ("forgot", "lost", "walked into") — they often ARE the hook
- ORDER hooks by streamer recognizability: the first hook becomes the first ~45 chars of the assembled title — the only part visible in mobile suggested feed. Most famous streamer or most universally understandable moment goes FIRST
- Always include the streamer name — never drop it, even for a streamer you don't recognize as famous
- Reference examples: "xQc lost fifty thousand", "HAchubby forgot live", "Lychee locker room theory", "wendolynortizz fire alarm", "Zerbs moving statues"
- NO emojis, NO channel suffix, NO apostrophes
- NEVER mention: "Stream", "Twitch", "Live" — describe the EVENT, not the platform
- Hooks must COMPLEMENT the thumbnail hook, not repeat it — if the thumbnail says "THEY LIED", no clipHook may contain "lied"
- Based on what you hear in the transcript

thumbnailHooks rules — HARD CONSTRAINTS:
- ONE entry per thumbnail clip — exactly the clipIds listed under "Thumbnail clips"
- ALL CAPS only — zero exceptions
- NO emojis — zero exceptions
- 2-4 words — hard limit
- Based on THAT CLIP's specific moment heard in transcript — not the overall episode
- Must NOT reveal the ending (never: "HE FALLS", "SHE WINS", "THIS GOES WRONG", "IT WORKS")
- Creates open loop: viewer sees hook and needs to watch to know what it refers to
- Must be readable at 200px wide (mobile feed) — short words, no clutter
- Good: "THEY LIED" / "PICK SOMEONE ELSE" / "LAST MEOW" / "SHE WARNED THEM" / "NOT AGAIN"
- Bad: "NOBODY SAW THIS COMING" (generic), "NO COMMENT" (no hook), any emoji
- Thumbnail hook and title must COMPLEMENT each other (thumbnail = emotion, title = context) — never the same words in both

thumbnailStrategy rules:
- Background frame: strong emotion or visible action, not a neutral talking-head
- High contrast — bright text on dark or vice versa, no busy background behind text
- Confirm the hook fits at 200px mobile width

shortsMetadata Title rules — HARD CONSTRAINTS:
- Purpose: search & discovery (Shorts feed topic matching, search, suggested) — the on-screen intro overlay handles retention separately.
- Streamer nickname ALWAYS FIRST, regardless of how famous or unknown they are — consistent identity branding across every short.
  Good: "xQc Reacts to a $7000 Knife"
  Good: "wendolynortizz Sets Off a Fire Alarm Mid-Cooking"
- Do NOT reveal the outcome. Title + thumbnail is a click decision in search/suggested — label the situation, withhold the resolution.
  Bad: "HAchubby Walked Right Into Traffic" (resolution given, nothing left to watch)
  Good: "HAchubby Crossed the Street at the Worst Moment"
- Always include ONE concrete searchable keyword: game name, category (Just Chatting/IRL), or specific action — never a vague label ("Funny Moment", "Crazy Clip").
- Max 60 chars, no emojis, no channel suffix, NEVER mention: "Stream", "Twitch", "Live".

shortsMetadata Description rules — HARD CONSTRAINTS:
- Purpose: pure SEO/topic matching. First sentence ≤100 chars and front-loads searchable entities: streamer name + game/category + what happened — it's the search snippet.
- No direct speech, no quotes, no "he said / she said" — describe WHAT HAPPENED.
- If another streamer appeared — name them; if it happened at an event (tournament, collab, IRL meetup) — name the event: these are extra searchable entities.
- Mention the game/category even if it's already in the title — repetition across title+description reinforces topic match.
- No openers: "In this clip", "Check out", "Watch as". No episode number.
- Closing CTA: OPTIONAL for shorts. If used — pick a DIFFERENT variant per short from the CTA rotation list (description rules below); across one day's shorts no two identical closers. Identical boilerplate across hundreds of uploads is a mass-produced-content signal — never repeat one fixed sentence.

```

Зберегти `clipHooks`, `thumbnailHooks`, `thumbnailStrategy`, `shortsMetadata` у `exports/metadata.json`.

---

## Після збереження — зібрати фінальний description

Timecodes, теги та хештеги додаються програмно скриптом `build-metadata.js`.

```bash
node scripts/build-metadata.js "<projectDir>"
```

Скрипт читає `exports/metadata.json` (згенерований Claude), збагачує теги/timecodes/хештеги і записує назад.

---

### Правила тегів

**Джерело правди** — `episode-plan.json` (кліпи які реально є у відео), НЕ scored-clips відсортовані по ddosScore.  
Стрімери у тегах — порядок появи у відео (timeline order).

#### Event-driven хештеги — ОБОВ'ЯЗКОВО

Якщо будь-який кліп пов'язаний з реальною хайповою подією — додати відповідні хештеги **і до episode tags, і до shortsMetadata[clip].hashtags**.

Приклади подій і хештегів:
| Подія | Теги до episodes | Теги до short |
|---|---|---|
| FIFA World Cup | WorldCup2026, FIFAWorldCup2026, FIFAWorldCup, WorldCup, FIFA | #FIFAWorldCup2026 #WorldCup2026 #WorldCup #FIFA #<country> |
| TwitchCon / FanExpo / fan con | TwitchCon, FanConvention | #TwitchCon #FanCon |
| Major esports tournament (Worlds, Majors, etc.) | + назва турніру | #LeagueWorlds #CSMajor etc. |
| Celebrity / boxing match | + імена учасників | #<Fighter1> #<Fighter2> #Boxing |
| Super Bowl / NBA Finals / будь-який major спорт | + назва події | #SuperBowl #NBAFinals etc. |

Визнач подію з transcript кліпу.

#### Базові теги — завжди (long-form відео)

```
DailyDoseOfStream, TwitchClips, TwitchHighlights, TwitchMoments,
StreamHighlights, Twitch, FunnyMoments, BestMoments, StreamerMoments,
ClipCompilation, TwitchCompilation, DailyHighlights, JustChatting, IRL, Streaming
```

#### Динамічні теги — стрімери

`broadcaster_name` кожного кліпу з `episode-plan.json`, у порядку першої появи.

#### Динамічні теги — категорії

| game_id | Теги |
|---------|------|
| 26936 (Music) | TwitchMusic, MusicStream |
| 509667 (Food) | CookingStream, FoodTwitch |
| 509671 (Fitness) | FitnessTwitch |
| 116747788 (Hot Tubs) | HotTubStream |
| 417752 (Talk Shows) | TwitchPodcast |
| Будь-яка gaming категорія | Gaming, TwitchGaming, GameClips + sanitized game name |

Gaming: `sanitizeGameTag(game_name)` → remove non-alphanumeric, CapitalizeEachWord, join.

#### Порядок у масиві `tags`
```
base → streamers (appearance order) → specialty → gaming base → game names
```
Hard cap: `.slice(0, 30)`.

#### Теги для Shorts (per clip)

```
#DailyDoseOfStream #TwitchClips #TwitchHighlights #<broadcaster_name> #<game/specialty>
```
Hard cap: 8 тегів. Game tag — перший зі списку specialty або sanitized game_name. Ніколи не додавати `#Shorts` — прибрано з шаблону навмисно.

---

### Timecodes (глави)

- Нова глава = новий `broadcaster_name` (у порядку кліпів з `episode-plan`)
- Перша глава завжди `00:00` (поглинає інтро 1.25s)
- Consecutive кліпи від ТОГО САМОГО стрімера — не новий таймкод
- INTRO_DUR = 1.25s, RECONNECT_DUR = 0, якщо `edit/reconnecting.mp4` нема (система більше не
  рендерить перебивку — reconnect монтується вручну в CapCut)
- Записується в `meta.chapters` (окреме поле, не вбудовується в опис — опису більше нема)

### Visible tags (для довідки на review, більше не вбудовуються в опис)

Перші 3 хештеги YouTube показує над заголовком відео — тому першими йдуть
топ-2 стрімери (клікабельні, мають пошуковий трафік) + #TwitchClips:

```
#Streamer1 #Streamer2 #TwitchClips #TwitchHighlights #DailyDoseOfStream #Twitch #StreamHighlights #FunnyMoments #StreamerMoments #Streamer3 ...
```

Будується програмно — `buildDescriptionHashtags` у `scripts/lib/metadata-utils.js`, записується
в `meta.visibleTags`. Разом з `meta.tags` (прихований YouTube tags field) і `meta.chapters`
показується на review.html у секції Tags — користувач копіює вручну в YouTube Studio при публікації.

Оновити `state.stages.metadata = "done"`.
