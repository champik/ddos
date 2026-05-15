# Skill: ddos-score

Транскрибуй кліпи, оціни через Claude, побудуй план епізоду, згенеруй хуки.

---

## TRANSCRIBE — faster-whisper

Для кожного завантаженого кліпу запусти Python скрипт:

```bash
python3 scripts/transcribe.py \
  "projects/<runId>/downloads/<clipId>.mp4" \
  "projects/<runId>/processed/<clipId>/transcript.json" \
  "<clipId>"
```

Якщо transcript.json вже існує — пропустити.
Якщо Python/faster-whisper не встановлений — записати `transcribe: "skipped"` і продовжити без транскрипту.

---

## SCORE — Claude оцінка

Для кожного кліпу викликай Claude API з таким промптом:

```
Ти оцінюєш Twitch кліп для "Daily Dose Of Stream" — щоденний YouTube дайджест стрімерської культури.
Контент: смішний, комфортний, курований. Не токсичний, не overproduced.

Кліп:
- Стрімер: <broadcaster_name>
- Категорія: <game_name>
- Мова: <language>
- Тривалість: <duration>s
- Назва: "<title>"
- Транскрипт (перші 400 символів): "<transcript_excerpt>"

Оціни кожне поле від 0 до 100. Будь строгим — не кожен кліп заслуговує на високий бал.

Відповідай ТІЛЬКИ валідним JSON без markdown:
{
  "retentionScore": 0-100,
  "funnyScore": 0-100,
  "payoffStrength": 0-100,
  "contextClarity": 0-100,
  "noveltyScore": 0-100,
  "shortsPotential": 0-100,
  "longFormPotential": 0-100,
  "transitionPotential": 0-100,
  "cooldownPotential": 0-100,
  "musicRisk": 0-100,
  "toxicityRisk": 0-100,
  "flags": [],
  "reasoning": "1-2 речення"
}
```

Розрахуй ddosScore за формулою з CLAUDE.md.
Зберегти у `processed/<clipId>/score.json`.
Зберегти всі scores у `clips/scored-clips.json`.

Показати таблицю топ-20 кліпів перед плануванням:
```
# | Стрімер          | Категорія    | DDOS | Funny | Shorts | Flags
1 | xQc              | Just Chatting| 87   | 92    | 85     |
2 | KaiCenat         | Just Chatting| 83   | 88    | 90     |
...
```

---

## PLAN — Claude будує план епізоду

Передай топ-25 scored кліпів Claude і попроси побудувати план:

```
Ти директор епізоду "Daily Dose Of Stream" #<N>.

Доступні кліпи (топ за DDOS score):
<список: clipId | стрімер | категорія | ddosScore | funnyScore | shortsPotential | cooldownPotential>

Правила:
- Обери 12–18 кліпів для long-form (мета 9–12 хв, середній кліп ~45с)
- Перший кліп — сильний, без повільного старту
- Чергуй емоційний тон (chaos / funny / wholesome / impressive)
- Максимум 3 кліпи від одного стрімера
- Обери 1 transitionClipId (для RECONNECTING переходу між сегментами)
- Обери 1 cooldownClipId (для закінчення: танець / wholesome / спів)
- Останній кліп перед cooldown — сильний
- Обери 5–8 кліпів для Shorts (найвищий shortsPotential)
- Згрупуй кліпи за категорією/настроєм у segments

Відповідай ТІЛЬКИ валідним JSON:
{
  "clipOrder": ["id1","id2",...],
  "openerClipId": "id",
  "closerClipId": "id",
  "transitionClipId": "id or null",
  "cooldownClipId": "id or null",
  "cooldownType": "dance|singing|wholesome|skip",
  "shortClipIds": ["id1",...],
  "segments": [{"label":"CS2 Chaos","clipIds":["id1","id2"],"tone":"chaotic"}],
  "reasoning": "коротке пояснення"
}
```

Зберегти у `edit/episode-plan.json` і `edit/shorts-selection.json`.

---

## HOOKS — текстові хуки

Для кожного кліпу з episode-plan.json згенеруй хук:

```
Згенеруй короткий текстовий хук для Twitch кліпу.

Стиль: саркастичний, anticipation-based, не спойлер. 2–5 слів. ALL CAPS.

Приклади хороших хуків:
THIS LOOKED FINE AT FIRST
HE REALLY THOUGHT THIS WOULD WORK  
ABSOLUTELY NOTHING COULD GO WRONG
NOT WHAT HE EXPECTED
WAIT FOR IT

Кліп:
- Стрімер: <name>
- Категорія: <game>
- Назва: "<title>"
- Транскрипт: "<excerpt>"

Відповідай ТІЛЬКИ текстом хуку, нічого більше.
```

Зберегти у `processed/<clipId>/hook.txt`.
Оновити `state.stages.score = "done"`, `state.stages.plan = "done"`, `state.stages.hooks = "done"`.
