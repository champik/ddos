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

Передай Claude список кліпів:

```
You are a YouTube video optimization specialist for "Daily Dose Of Stream" (DDOS) — a daily Twitch clip digest channel (funny, comfortable, curated). English-speaking audience.

Framework:
- Retention-first: the first 30 seconds determine watch-through. Titles and thumbnails must hook without deception.
- Thumbnails tell micro-stories. Mobile-first: readable at 200px width.
- Five title options, each targeting a DIFFERENT psychological trigger.
- Shorts captions must stop the scroll in under 10 words.

Episode data:
  Episode #: <N>
  Clips (in order): <streamer | category | clip title | ddosScore>
  Main hook moment: <strongest clip — streamer + brief description of what happened>

Respond ONLY with valid JSON, no markdown:
{
  "titleOptions": {
    "curiosityGap":      "<title>",
    "specificityStakes": "<title>",
    "emotionCharacter":  "<title>",
    "chatReaction":      "<title>",
    "unexpectedOutcome": "<title>"
  },
  "thumbnailHook": "<2-4 WORDS ALL CAPS — must NOT reveal the ending>",
  "thumbnailStrategy": "<One sentence: which frame moment to use, what emotion/action is visible, why it works at mobile size.>",
  "description": "<150-200 words English. First 2 sentences: drop viewer into the main hook moment immediately — name the streamer, describe the action, why it's unexpected or hilarious. Middle: set expectations for variety. End EXACTLY with: Subscribe for daily Twitch highlights and the best stream moments every day!>",
  "shortsMetadata": [
    {
      "clipId": "<id>",
      "title": "<scroll-stopping hook — max 60 chars, no channel suffix, no emojis>",
      "caption": "<scroll-stopper: emotional hook in under 10 words, present tense>",
      "hashtags": ["#DailyDoseOfStream","#TwitchClips","#Shorts","#<streamer>"]
    }
  ]
}

Title rules — HARD CONSTRAINTS (violating any = wrong answer):
- Max 65 characters per title
- DO NOT add "| Daily Dose Of Stream" or any channel suffix — titles are standalone
- NO emojis anywhere in any title
- Every title must start with the streamer name from the main hook
- BANNED phrases — never use any of these or close variants:
  "Nobody Expected", "Nobody Was Ready", "He Had No Response", "No One Saw This Coming",
  "This Happened", "Things Escalated", "Way Faster Than Expected", "He Had No Idea",
  "This Goes Wrong", "You Won't Believe", "Nobody Saw This Coming"

Trigger definitions:
- curiosityGap: open a loop viewer must click to close. Reveal the outcome exists, not what it was.
  Good: "Something in HAchubby's Apartment Fought Back on Stream"
  Bad: any banned phrase above
- specificityStakes: who + exact situation + consequence. Must include "Twitch" or "Stream".
  Good: "HAchubby vs The Mattress — The Mattress Won on Twitch"
- emotionCharacter: lead with streamer feeling or personality — relatable, funny, or wholesome.
  Good: "xQc Completely Lost It When This Happened on His IRL Stream"
- chatReaction: chat as a character — what chat did or couldn't do.
  Good: "Chat Had Nothing to Say After What HAchubby Did on Stream"
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

description rules:
- Hook in first 2 sentences: drop viewer into the main moment NOW — no "In this episode..." opener
- Natural keywords: streamer names, Twitch clips, stream moments
- NO social links, NO URLs
- End EXACTLY: "Subscribe for daily Twitch highlights and the best stream moments every day!"

Shorts title rules:
- Max 60 characters, no channel suffix, no emojis
- Lead with the streamer name or the action — not a generic phrase

Shorts caption rules:
- Present tense, under 10 words
- Emotional — make viewer feel they'll miss something if they scroll
- Good: "He actually did it" / "Chat could NOT believe this happened"
- Bad: passive voice, generic "funny moment", recap of title, any banned phrase
```

Зберегти raw JSON у `exports/metadata.json`.

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
