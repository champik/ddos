---
name: ddos-youtube-creatives
description: Use when generating YouTube titles, thumbnail hooks, descriptions, tags, hashtags, or Shorts captions for a DDOS episode — applies retention-first marketing framework to all creative assets
---

# Skill: ddos-youtube-creatives

Генерація всіх YouTube-креативів для DDOS епізоду: назви, текст на обкладинці, опис, теги, хештеги, субтитри для Shorts.

Фреймворк: retention-first marketing — psychological trigger titles, mobile-first thumbnails, scroll-stopping Shorts captions.

## Метрики успіху (цілі)

| Метрика | Ціль |
|---------|------|
| CTR | ≥ 8% |
| Retention на 3-хв. позначці | ≥ 50% |
| Views-to-subscriber | ≥ 1% |
| Algorithmically suggested traffic | +40% |

---

## Stage 12 — запуск

**Залежність:** має виконатись ДО `ddos-shorts` RENDER SHORTS — `render-shorts.js` бере intro-хук
з `exports/metadata.json → shortIntros`. Якщо metadata.json ще не існує на момент рендеру шортсів,
intro-хук тихо не рендериться (без помилки) і шортси виходять без нього.

```bash
node scripts/progress.js "<projectDir>" 12 "YouTube metadata (Claude)"
```

Перед генерацією промпту зчитати дані автоматично:
0. **Анти-шаблон:** прочитати `description` з `exports/metadata.json` останніх 2-3 попередніх
   епізодів. Знайти їх у `projects/`:
   ```bash
   ls -1dt projects/*/Episode_*/exports/metadata.json | head -4
   ```
   (`-t` сортує за часом зміни; поточний епізод пропустити). Якщо файлів немає — пропустити крок.
   Передати їх у промпт як `Previous episode descriptions` — модель зобов'язана НЕ повторювати
   структуру перших речень і закривачку.
1. `edit/episode-plan.json` → список кліпів в порядку відео + `shortClipIds`
2. `clips/scored-clips.json` → `broadcaster_name`, `title`, `view_count`, `game_name` по кожному clipId
3. `edit/editorial.json` → `thumbnails` array (список clipId для яких потрібні `thumbnailHooks`)
4. Для кожного кліпу з `clipOrder`:
   - `processed/<clipId>/transcript.json` → `text` (повний, без обрізки)
   - Якщо transcript відсутній → `""` (порожній рядок)
   - Прочитати через Read tool (якщо існують):
     `<projectDir>/processed/<clipId>/frames/frame-1.jpg`
     `<projectDir>/processed/<clipId>/frames/frame-2.jpg`
     `<projectDir>/processed/<clipId>/frames/frame-3.jpg`
   - Читати кадри ПЕРЕД текстовими даними кожного кліпу щоб Claude асоціював їх з правильним clipId
   - Якщо frames відсутні — продовжити без них
5. Для кліпів з `shortClipIds` — передати повний transcript окремо у `shortsTranscripts`

Передай Claude список кліпів:

```
You are a YouTube video optimization specialist for "Daily Dose Of Stream" (DDOS) — a daily Twitch clip digest channel (funny, comfortable, curated). English-speaking audience.

Framework:
- Retention-first: the first 30 seconds determine watch-through. Titles and thumbnails must hook without deception.
- Thumbnails tell micro-stories. Mobile-first: readable at 200px width.
- Google & AI Overviews: YouTube is core Google search infrastructure. Long-form clips compilations (12-15 min) dominate AI citation (94% of cited videos). First 160 chars of description = Google SERP meta description — optimize for it.
- Use frames AND transcript together to build a complete picture of what happened in the clip. Frames show visual context; transcript provides spoken words. Never invent details absent from both.

Episode data:
  Episode #: <N>
  Clips (in order):
  [clipId] streamer | category | clip title
  Frames: [3 keyframes read above via Read tool — peak moment context]
  Transcript: "<full transcript text or 'no transcript'>"
  ---
  (repeat for each clip; read frames first, then include this text)

  Shorts:
  [clipId] streamer | game/category | clip title
  Transcript: "<full transcript>"
  ---
  (repeat for each short)

  Thumbnail clips (need thumbnailHooks): <comma-separated list of clipIds from editorial.thumbnails>

  Recognizable streamers (universally famous — xQc, Kai Cenat, HAchubby тощо): <comma-separated list, or "none">

  Previous episode descriptions (do NOT reuse their sentence structure, question, or closing CTA):
  1. "<description of previous episode>"
  2. "<...>"
  (up to 3; omit block if none found)

Respond ONLY with valid JSON, no markdown:
{
  "clipHooks": [
    {"clipId": "<id>", "hook": "<StreamerName Action/Event — max 60 chars>"}
  ],
  "thumbnailHooks": [
    {"clipId": "<id>", "hook": "<2-4 WORDS ALL CAPS>"}
  ],
  "thumbnailStrategy": "<One sentence: which frame moment to use, what emotion/action is visible, why it works at mobile size.>",
  "description": "<150-200 words English. Opening 2 sentences: name the streamer, describe the specific action or outcome — no 'In this episode' or 'Today's episode covers'. Then one flowing paragraph (NOT a list) describing 4-6 other moments with specific details and outcomes; weave in game names and category keywords naturally. No direct quotes, no 'zero filler', no 'all in one sitting', no episode number. Closing CTA — see description rules (rotation, never the same as previous episodes).>",
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
- Based on what you see in frames and/or hear in transcript

thumbnailHooks rules — HARD CONSTRAINTS:
- ONE entry per thumbnail clip — exactly the clipIds listed under "Thumbnail clips"
- ALL CAPS only — zero exceptions
- NO emojis — zero exceptions
- 2-4 words — hard limit
- Based on THAT CLIP's specific moment visible in frames or heard in transcript — not the overall episode
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

description rules — HARD CONSTRAINTS:
- First 160 characters = Google SERP meta description. Must include streamer name + specific action from transcript + keyword.
- First 2 sentences: drop into the main hook moment immediately — describe the specific action or outcome. No "In this episode...", no "Today's episode covers..."
- Body (one flowing paragraph, NOT a list): describe 4-6 other moments with concrete actions and outcomes. Weave in streamer names, game names naturally.
- NO direct quotes or speech from transcripts — describe WHAT HAPPENED, not what was said. Paraphrase only. No quote marks anywhere.
- EVERY detail must come from frames or transcript — no invented outcomes
- If the user gave corrections to short titles or intros (e.g. "sunscreen spray" instead of "hotel room moment") — use that SPECIFIC context in the episode description too, not the generic version
- BANNED closing phrases: "zero filler", "all in one sitting", "at its finest", "maximum reaction", episode number
- Second-to-last line: ONE short engagement question to drive comments, on its own line. Examples: "Which moment got you? Drop a timestamp below." / "Whose reaction was the best? Tell us in the comments." Vary it between episodes.
- ANTI-TEMPLATE: you are given "Previous episode descriptions" — do NOT reuse their opening sentence structure, their engagement question, or their closing CTA. Same-looking descriptions day after day read as mass-produced content.
- Closing CTA: pick ONE from the rotation list below, never the same as the previous episode (check "Previous episode descriptions"):
  1. "Subscribe for daily Twitch highlights and the best stream moments every day!"
  2. "A fresh compilation of the best live moments drops every day — subscribe so you don't miss one."
  3. "New episode every single day — subscribe for tomorrow's dose."
  4. "The best stream moments, curated daily — subscribe to keep them coming."
  5. "One episode a day, only the moments worth watching — subscribe."
- NO social links, NO URLs, NO episode number anywhere

Good example (Ep 12 style):
  Stormfall33 was playing 007 First Light and delivered a Bond villain line so unexpected it stopped chat mid-scroll. CookSux survived a paragliding takeoff that probably shouldn't have gone that way. xQc reacted to a $7,000 knife with his entire body. Jynxzi coached a viewer to their first penta kill in League of Legends.
  Subscribe for daily Twitch highlights and the best stream moments every day!

Bad example (avoid):
  Today's episode covers IRL chaos, gaming moments, and wholesome content. Featuring xQc, HAchubby, and more — every clip selected for maximum reaction, zero filler. Funny, chaotic, and wholesome all in one sitting.
  Subscribe for daily Twitch highlights and the best stream moments every day!

```

Зберегти `clipHooks`, `thumbnailHooks`, `thumbnailStrategy`, `description`, `shortsMetadata`, `chapterDescriptions` у `exports/metadata.json`.

> **Shorts title/description генеруються в основному промпті вище** (shortsMetadata rules) —
> окремого другого запиту більше немає: в одному контексті модель бачить кадри, транскрипти
> і решту креативів, тому title/intro/description не дублюють одне одного. Філософія та сама:
> title+description = search & discovery, retention — виключно intro-текст на відео (розділ нижче).

---

## Shorts intro text — окремий запит

Це єдиний елемент шортса, що відповідає за retention — чистий bait-текст, який змушує дивитися далі, а не проскролити. Title/description (вище) — для пошуку; інтро-текст ніколи не описує суть кліпу, тільки створює крючок.

Після збереження `shortsMetadata` — ще один запит до Claude для intro overlay тексту:

```
You are writing scroll-stopping intro overlays for YouTube Shorts (1-3 second hold before swipe).
This text is the ONLY thing keeping the viewer from swiping away — pure bait, never a summary.

For each short below, write ONE sentence (max 12 words) that makes the viewer freeze and watch.
It must be DIFFERENT from the title — titles describe what happens, intro text creates suspense or curiosity.
Never repeat words from the title. No emojis.

Rules:
- Create an open loop — imply something unexpected, surprising, or unresolved
- Do NOT reveal the outcome
- Works with a stranger who just landed on this video with zero context
- Good: "He had no idea what was about to happen", "This wasn't supposed to go this way", "Nobody in chat saw this coming"
- Bad: "Watch this amazing clip", "You won't believe this" (cliché), anything that summarizes the ending

For each short:
[clipId] title: "<shortsMetadata title>"
Transcript: "<full transcript>"
---

Respond ONLY with valid JSON:
[{"clipId": "<id>", "introText": "<max 12 words, no emojis>"}]
```

Merge результат у `exports/metadata.json` → `shortIntros: [{"clipId": "<id>", "introText": "<text>"}]`.

Зберегти повний `exports/metadata.json`.

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

Визнач подію з transcript + frames кліпу. Якщо event видно на scoreboard, одязі, банерах — це підтвердження.

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
- INTRO_DUR = 1.25s, RECONNECT_DUR = реальна тривалість `edit/reconnecting.mp4` (ffprobe, НЕ хардкод 1.0s)

### Хештеги у description

Перші 3 хештеги YouTube показує над заголовком відео — тому першими йдуть
топ-2 стрімери (клікабельні, мають пошуковий трафік) + #TwitchClips:

```
#Streamer1 #Streamer2 #TwitchClips #TwitchHighlights #DailyDoseOfStream #Twitch #StreamHighlights #FunnyMoments #StreamerMoments #Streamer3 ...
```

(будується програмно — `buildDescriptionHashtags` у `scripts/lib/metadata-utils.js`)

### Фінальний формат description

```
HAchubby's delivery driver refused to leave the camera — and what happened next had chat losing it...
[... 150-200 слів від Claude ...]
Which moment got you? Drop a timestamp below.
Subscribe for daily Twitch highlights and the best stream moments every day!

00:00 HAchubby
00:21 theavamariee
01:13 Gorgc

#HAchubby #theavamariee #TwitchClips #TwitchHighlights #DailyDoseOfStream #Twitch #StreamHighlights #FunnyMoments #StreamerMoments #Gorgc
```

Оновити `state.stages.metadata = "done"`.
