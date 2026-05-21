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
- Three title options always target DIFFERENT psychological triggers.
- Shorts captions must stop the scroll in under 10 words.

Episode data:
  Episode #: <N>
  Clips (in order): <streamer | category | clip title | ddosScore>
  Main hook moment: <strongest clip — streamer + brief description of what happened>

Respond ONLY with valid JSON, no markdown:
{
  "titleOptions": {
    "curiosityGap": "<open a loop — reference the outcome without revealing it. Never use: Nobody Expected / He Had No Response / This Happened> | Daily Dose Of Stream",
    "specificityStakes": "<who + exact situation + consequence. Must include Twitch or Stream keyword> | Daily Dose Of Stream",
    "emotionCharacter": "<feeling or streamer personality — relatable, funny, or wholesome angle> | Daily Dose Of Stream"
  },
  "thumbnailHook": "<2-4 WORDS ALL CAPS, 1 emoji max — emotional reaction that creates open loop. Readable at 200px.>",
  "thumbnailStrategy": "<One sentence: which frame moment to use, what emotion/action is visible, why it works at mobile size.>",
  "description": "<150-200 words English. First 2 sentences: drop viewer into the main hook moment immediately — name the streamer, describe the action, why it's unexpected or hilarious. Middle: set expectations for variety. End EXACTLY with: Subscribe for daily Twitch highlights and the best stream moments every day!>",
  "shortsMetadata": [
    {
      "clipId": "<id>",
      "title": "<scroll-stopping hook — 60 chars max> | Daily Dose Of Stream",
      "caption": "<scroll-stopper: emotional hook in under 10 words, present tense. Good: 'He actually did it 😭' / Bad: recapping the clip title>",
      "hashtags": ["#DailyDoseOfStream","#TwitchClips","#Shorts","#<streamer>"]
    }
  ]
}

Title rules:
- curiosityGap: open a loop viewer must click to close. Reveal the outcome exists, not what it was.
  Good: "Something in HAchubby's Apartment Fought Back on Stream 💀"
  Bad: "Nobody Expected...", "He Had No Response", "This Happened"
- specificityStakes: who + what happened + consequence, concrete, must include "Twitch" or "Stream".
  Good: "HAchubby vs The Mattress... The Mattress Won 💀 | Twitch Clip"
- emotionCharacter: lead with feeling or personality, funny/wholesome/relatable.
  Good: "xQc Completely Lost It When This Happened on His IRL Stream"
- All options: lead with the streamer name from the main hook. NOT generic filler verbs.
- For compilations with no single standout moment: option 3 only may mention "compilation".

thumbnailHook rules:
- Same main hook moment as the title — creates open loop ("what does IT refer to?")
- ALL CAPS, 2-4 words, 1 emoji max
- Must be readable at 200px wide (mobile feed) — short words, no clutter
- Good: "IT WON 😭" / "NO WAY 💀" / "HOW???" / "WAIT FOR IT"
- Bad: repeating title wording, different moment than title, more than 4 words

thumbnailStrategy rules:
- Background frame: strong emotion or visible action, not a neutral talking-head
- High contrast — bright text on dark or vice versa, no busy background behind text
- Confirm the hook fits at 200px mobile width

description rules:
- Hook in first 2 sentences: drop viewer into the main moment NOW — no "In this episode..." opener
- Natural keywords: streamer names, Twitch clips, stream moments
- NO social links, NO URLs
- End EXACTLY: "Subscribe for daily Twitch highlights and the best stream moments every day!"

Shorts caption rules:
- Present tense, under 10 words
- Emotional — make viewer feel they'll miss something if they scroll
- Good: "He actually did it 😭" / "Chat could NOT believe this happened"
- Bad: passive voice, generic "funny moment", recap of title
```

Зберегти raw JSON у `exports/metadata.json`.

---

## Після збереження — зібрати фінальний description

Timecodes, теги та хештеги додаються програмно після генерації Claude.

### Теги — завжди включати нікнейми стрімерів

```javascript
const streamerTags = [...new Set(
  plan.groups.flatMap(g => g.clipIds.map(id => scored.find(c => c.id === id)?.broadcaster_name))
)].filter(Boolean);

meta.tags = [
  'DailyDoseOfStream','TwitchClips','Streaming','JustChatting','IRL',
  'Twitch','TwitchHighlights','StreamerMoments',
  ...streamerTags
];
```

### Видимі хештеги — базові + топ-5 стрімерів за ddosScore

```javascript
const topStreamers = streamerTags.slice(0, 5).map(s => '#' + s.replace(/\s/g, '')).join(' ');
const baseHashtags = '#DailyDoseOfStream #TwitchClips #Streaming #JustChatting #IRL #Twitch #TwitchHighlights #StreamerMoments';
```

### Timecodes (глави)

Правила:
- Кожна нова плашка стрімера = нова глава (перший кліп групи + перший кліп від нового стрімера)
- Consecutive кліпи від ТОГО САМОГО стрімера — НЕ новий таймкод
- Перша глава ЗАВЖДИ `00:00` (поглинає інтро)
- Нікнейм з `scored-clips.json` (broadcaster_name), БЕЗ `@`
- INTRO_DUR = 1.25s, RECONNECT_DUR = 1.0s між групами

```javascript
// fmt(secs): "MM:SS" або "H:MM:SS" для відео >1 год
// YouTube: перший timestamp = 00:00, мінімум 3 глави, зростаючий порядок
const chaptersStr = chapters.map(c => fmt(c.t) + ' ' + c.broadcasterName).join('\n');
```

### Фінальний формат description

```
HAchubby's delivery driver refused to leave the camera — and what happened next had chat losing it...
[... 150-200 слів від Claude ...]
Subscribe for daily Twitch highlights and the best stream moments every day!

00:00 HAchubby
00:21 theavamariee
01:13 Gorgc

#DailyDoseOfStream #TwitchClips #Streaming #JustChatting #IRL #Twitch #TwitchHighlights #StreamerMoments #xQc #HAchubby #Gorgc
```

```javascript
meta.description = meta.description + '\n\n' + chaptersStr + '\n\n' + baseHashtags + ' ' + topStreamers;
```

Оновити `state.stages.metadata = "done"`.
