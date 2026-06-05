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

## Stage 14 — запуск

```bash
node scripts/progress.js "projects/<runId>" 13 "YouTube metadata (Claude)"
```

Перед генерацією промпту зчитати дані автоматично:
1. `edit/episode-plan.json` → список кліпів в порядку відео + `shortClipIds`
2. `clips/scored-clips.json` → `broadcaster_name`, `title`, `view_count`, `game_name` по кожному clipId
3. `edit/editorial.json` → `thumbnails` array
4. Для кожного кліпу з `clipOrder`:
   - `processed/<clipId>/transcript.json` → `text` (повний, без обрізки)
   - Якщо transcript відсутній → `""` (порожній рядок)
5. Для кліпів з `shortClipIds` — передати повний transcript окремо у `shortsTranscripts`

Передай Claude список кліпів:

```
You are a YouTube video optimization specialist for "Daily Dose Of Stream" (DDOS) — a daily Twitch clip digest channel (funny, comfortable, curated). English-speaking audience.

Framework:
- Retention-first: the first 30 seconds determine watch-through. Titles and thumbnails must hook without deception.
- Thumbnails tell micro-stories. Mobile-first: readable at 200px width.
- Five title options, each targeting a DIFFERENT psychological trigger.
- Google & AI Overviews: YouTube is core Google search infrastructure. Long-form clips compilations (12-15 min) dominate AI citation (94% of cited videos). First 160 chars of description = Google SERP meta description — optimize for it.
- ALL output must be based ONLY on what actually happened in the transcripts — never invent quotes, actions, or outcomes not present in the transcript.

Episode data:
  Episode #: <N>
  Clips (in order):
  [clipId] streamer | category | clip title
  Transcript: "<full transcript text or 'no transcript'>"
  ---
  (repeat for each clip)

  Shorts:
  [clipId] streamer | clip title
  Transcript: "<full transcript>"
  ---
  (repeat for each short)

  Main hook: <clip with longest/most interesting transcript — streamer + key quote or action from transcript>

Respond ONLY with valid JSON, no markdown:
{
  "titleOptions": {
    "curiosityGap":      "<title>",
    "specificityStakes": "<title>",
    "emotionCharacter":  "<title>",
    "directMoment":      "<title>",
    "unexpectedOutcome": "<title>"
  },
  "thumbnailCaptions": [
    "<pipe-title variant 1>",
    "<pipe-title variant 2>",
    "<pipe-title variant 3>"
  ],
  "thumbnailHook": "<2-4 WORDS ALL CAPS — must NOT reveal the ending>",
  "thumbnailStrategy": "<One sentence: which frame moment to use, what emotion/action is visible, why it works at mobile size.>",
  "description": "<150-200 words English. Opening 2 sentences: name the streamer, describe the specific action, why it landed — no 'In this episode' or 'Today's episode covers'. Then one flowing paragraph (NOT a list) describing 4-6 other moments with specific details, quotes, or outcomes; weave in game names and category keywords naturally. No 'zero filler', no 'all in one sitting', no episode number. End EXACTLY: Subscribe for daily Twitch highlights and the best stream moments every day!>",
  "chapterDescriptions": {
    "<clipId>": "<streamer name + action + consequence from transcript — max 6 words after streamer name, no invented details>"
  },
  "shortsMetadata": [
    {
      "clipId": "<id>",
      "title": "<MUST start with streamer name, then action/hook — max 60 chars, no channel suffix, no emojis>",
      "description": "<50-80 words English. First sentence: streamer name + specific action + why it landed — no 'In this clip', no 'Check out', no 'Watch as'. Second sentence: context with game name or Just Chatting/IRL keyword + reaction or outcome detail. No generic phrases, no list, no episode number. End EXACTLY: Subscribe for daily Twitch highlights and the best stream moments every day!>",
      "hashtags": ["#DailyDoseOfStream","#TwitchClips","#Shorts","#<streamer>"]
    }
  ]
}

Title rules — HARD CONSTRAINTS (violating any = wrong answer):
- Aim ≤60 characters (mobile optimal — YouTube truncates at ~60 on small screens); never exceed 65
- DO NOT add "| Daily Dose Of Stream" or any channel suffix — titles are standalone
- NO emojis anywhere in any title
- Every title must start with the streamer name from the main hook
- NEVER mention: "Stream", "Twitch", "Live", "IRL", "on stream", "on Twitch", "live stream" — describe the EVENT itself, not the platform
- BANNED phrases — never use any of these or close variants:
  "Nobody Expected", "Nobody Was Ready", "He Had No Response", "No One Saw This Coming",
  "This Happened", "Things Escalated", "Way Faster Than Expected", "He Had No Idea",
  "This Goes Wrong", "You Won't Believe", "Nobody Saw This Coming"

Trigger definitions:
- curiosityGap: open a loop viewer must click to close. Reveal the outcome exists, not what it was.
  Good: "Something in HAchubby's Apartment Fought Back on Stream"
  Bad: any banned phrase above
- specificityStakes: searchable keyword or action FIRST, streamer second. Format: "[What happened] — [Streamer]". Optimized for search, not just recognition.
  Good: "Truck Runs a Red Light Into HAchubby's IRL Walk", "Yoga Session Turns Into Chaos for Alinity"
- emotionCharacter: lead with streamer feeling or personality — relatable, funny, or wholesome.
  Good: "xQc Completely Lost It When This Happened on His IRL Stream"
- directMoment: plain description of what happened — no tricks, no loops. Someone who reads it knows exactly what the clip is about.
  Good: "HAchubby Almost Gets Hit by a Truck Mid-Walk"
- unexpectedOutcome: the expected thing didn't happen — describe the gap without spoiling the ending.
  Good: "HAchubby's Delivery Plan Worked Perfectly Except for One Thing"

thumbnailHook rules — HARD CONSTRAINTS:
- ALL CAPS only — zero exceptions
- NO emojis — zero exceptions
- 2-4 words — hard limit
- Must NOT reveal the ending (never: "HE FALLS", "SHE WINS", "THIS GOES WRONG", "IT WORKS")
- Creates open loop: viewer sees the hook and needs to watch to know what it refers to
- Must be readable at 200px wide (mobile feed) — short words, no clutter
- Good: "IT WON" / "PICK SOMEONE ELSE" / "LAST MEOW" / "SHE WARNED THEM" / "NOT AGAIN"
- Bad: "NOBODY SAW THIS COMING" (generic), "NO COMMENT" (no hook), any emoji

thumbnailStrategy rules:
- Background frame: strong emotion or visible action, not a neutral talking-head
- High contrast — bright text on dark or vice versa, no busy background behind text
- Confirm the hook fits at 200px mobile width

thumbnailCaptions rules — these are Style 2 video title alternatives (pipe-separated):
- Array of exactly 3 variants covering the 3-4 most memorable moments from the episode
- Format: "Streamer [verb + result/surprise] | Streamer [verb + result/surprise] | ..."
- Each segment MUST have: active verb + unexpected result OR surprising consequence — never just what they did
- NO emojis, NO punctuation within segments, NO channel suffix
- NEVER mention: "Stream", "Twitch", "Live", "IRL" — same rule as titleOptions
- Total length per variant: max 100 characters
- 3 variants must feel tonally distinct — e.g. one dramatic, one absurd, one funny
- ONLY use details from the provided transcripts — never invent actions, reactions, or outcomes

chapterDescriptions rules:
- Only for clips that START a new chapter (first clip from each broadcaster in episode order)
- Format: "[StreamerName] [action] [consequence]" — reads as one natural sentence
- Max 8 words total including streamer name
- Must come from transcript — no invented details
- Good: "HAchubby almost walks into oncoming traffic", "xQc loses fifty thousand on one bet"
- Bad: "HAchubby has a funny moment" (vague), invented outcome not in transcript
- Good segments: "xQc breaks keyboard mid-game", "HAchubby almost hit by truck", "Kai loses it completely", "CaseOH falls off chair"
- Bad segments: "xQc reacts to something" (vague), "HAchubby does yoga" (just an action, no twist), invented details not in transcript

description rules — HARD CONSTRAINTS:
- First 160 characters = Google SERP meta description. Must include streamer name + specific action from transcript + keyword.
- First 2 sentences: drop into the main hook moment immediately — use real quotes or specific actions from the transcript. No "In this episode...", no "Today's episode covers..."
- Body (one flowing paragraph, NOT a list): describe 4-6 other moments using REAL details from their transcripts — actual quotes, specific words said, concrete actions. Weave in streamer names, game names naturally.
- EVERY detail must come from the provided transcripts — no invented quotes, no fabricated outcomes
- BANNED closing phrases: "zero filler", "all in one sitting", "at its finest", "maximum reaction", episode number
- End EXACTLY: "Subscribe for daily Twitch highlights and the best stream moments every day!"
- NO social links, NO URLs, NO episode number anywhere

Good example (Ep 12 style):
  Stormfall33 was playing 007 First Light and delivered a Bond villain line so unexpected it stopped chat mid-scroll — "you've meowed your last meow." CookSux survives a paragliding takeoff that probably shouldn't have gone that way. xQc reacts to a $7,000 knife with his entire body. Jynxzi coaches a viewer to their first penta kill in League of Legends. Seventeen moments earned.
  Subscribe for daily Twitch highlights and the best stream moments every day!

Bad example (avoid):
  Today's episode covers IRL chaos, gaming moments, and wholesome content. Featuring xQc, HAchubby, and more — every clip selected for maximum reaction, zero filler. Funny, chaotic, and wholesome all in one sitting.
  Subscribe for daily Twitch highlights and the best stream moments every day!

```

Зберегти `titleOptions`, `thumbnailCaptions`, `thumbnailHook`, `thumbnailStrategy`, `description`, `chapterDescriptions` у `exports/metadata.json`.

---

## Shorts — окремий промпт

Shorts алгоритм відрізняється від лонгформ: пріоритет — watch-through rate в vertical feed, не CTR з пошуку. Після збереження основного metadata — окремий запит до Claude:

```
You are optimizing YouTube Shorts for "Daily Dose Of Stream" — a Twitch clip channel.

Shorts algorithm priorities (different from long-form):
- Watch-through rate matters more than CTR — the title/description must make viewer STAY, not just click
- Shorts titles appear in search and suggested — optimize for the action/moment, not the streamer name
- Hook in first 2 seconds = retention. Describe that hook in the title.

For each short:
[clipId] streamer | game/category
Transcript: "<full transcript>"
---

Respond ONLY with valid JSON:
[
  {
    "clipId": "<id>",
    "title": "<max 60 chars — lead with the action or surprise from transcript, not streamer name>",
    "description": "<50-80 words. First sentence: what happens in the first 2 seconds (the hook). Second sentence: game/category keyword + how it ends. No openers: 'In this clip', 'Check out'. End EXACTLY: Subscribe for daily Twitch highlights and the best stream moments every day!>"
  }
]

Title rules for Shorts:
- MUST start with streamer name — no exceptions
- After the name: action or surprise that hooks the viewer
- Good: "HAchubby Walked Right Into Traffic Mid-Broadcast", "xQc Said It Live and Couldn't Take It Back"
- Bad: "She Walked Right Into Traffic" (missing name), "HAchubby's Funny Moment" (vague action)
- Max 60 chars, no emojis, no channel suffix
- NEVER mention: "Stream", "Twitch", "Live"
```

Merge Shorts результат у `exports/metadata.json` → `shortsMetadata[]` (додати `hashtags: ["#DailyDoseOfStream","#TwitchClips","#Shorts","#<streamer>"]` програмно).

Зберегти повний `exports/metadata.json`.

---

## Після збереження — зібрати фінальний description

Timecodes, теги та хештеги додаються програмно скриптом `build-metadata.js`.

```bash
node scripts/build-metadata.js "projects/<runId>"
```

Скрипт читає `exports/metadata.json` (згенерований Claude), збагачує теги/timecodes/хештеги і записує назад.

---

### Правила тегів

**Джерело правди** — `episode-plan.json` (кліпи які реально є у відео), НЕ scored-clips відсортовані по ddosScore.  
Стрімери у тегах — порядок появи у відео (timeline order).

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
#DailyDoseOfStream #TwitchClips #TwitchHighlights #Shorts #<broadcaster_name> #<game/specialty>
```
Hard cap: 8 тегів. Game tag — перший зі списку specialty або sanitized game_name.

---

### Timecodes (глави)

- Нова глава = новий `broadcaster_name` (у порядку кліпів з `episode-plan`)
- Перша глава завжди `00:00` (поглинає інтро 1.25s)
- Consecutive кліпи від ТОГО САМОГО стрімера — не новий таймкод
- INTRO_DUR = 1.25s, RECONNECT_DUR = 1.0s між групами

### Хештеги у description — базові + топ-5 стрімерів по появі

```
#DailyDoseOfStream #TwitchClips #TwitchHighlights #Twitch #StreamHighlights #FunnyMoments #StreamerMoments #Streamer1 #Streamer2 ...
```

### Фінальний формат description

```
HAchubby's delivery driver refused to leave the camera — and what happened next had chat losing it...
[... 150-200 слів від Claude ...]
Subscribe for daily Twitch highlights and the best stream moments every day!

00:00 HAchubby
00:21 theavamariee
01:13 Gorgc

#DailyDoseOfStream #TwitchClips #TwitchHighlights #Twitch #StreamHighlights #FunnyMoments #StreamerMoments #HAchubby #theavamariee #Gorgc
```

Оновити `state.stages.metadata = "done"`.
