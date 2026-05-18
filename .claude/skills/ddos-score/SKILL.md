# Skill: ddos-score

Транскрибуй кліпи, оціни через Claude, побудуй план епізоду, згенеруй хуки.

---

## TRANSCRIBE — faster-whisper

```bash
node scripts/progress.js "projects/<runId>" 4 "Транскрипція (Whisper large-v3)"
```

Для кожного завантаженого кліпу запусти Python скрипт:

Шлях до відео брати з `clips/downloaded-clips.json` → `clip.localPath`.

```bash
python3 scripts/transcribe.py \
  "<clip.localPath>" \
  "projects/<runId>/processed/<clipId>/transcript.json" \
  "<clipId>"
```

Якщо transcript.json вже існує — пропустити.
Якщо Python/faster-whisper не встановлений — записати `transcribe: "skipped"` і продовжити без транскрипту.

---

## SCORE — Claude оцінка (batch, 8 кліпів за раз)

```bash
node scripts/progress.js "projects/<runId>" 5 "Оцінювання кліпів (Claude)"
```

**Батчинг обов'язковий** — ніколи не оцінювати по одному кліпу. Групувати по 8 і відправляти один запит.

Для кожної групи 8 кліпів:
1. Прочитати `processed/<clipId>/transcript.json` якщо існує (перші 400 символів)
2. Відправити один batch prompt:

**Scoring prompt (batch):**
```
Ти оцінюєш Twitch кліпи для "Daily Dose Of Stream".
Канал: смішний, комфортний, курований. Не токсичний.

Оціни кожен кліп від 0 до 100. Будь строгим — більшість кліпів 40-70, лише справді видатні 80+.

Кліпи:
[1] <clipId>
  Стрімер: <broadcaster_name>, Категорія: <game_name>, Мова: <language>, Тривалість: <duration>s
  Назва: "<title>"
  Транскрипт: "<excerpt>"

[2] ...
(до 8 кліпів)

Відповідай ТІЛЬКИ валідним JSON масивом (без markdown):
[
  {
    "clipId": "...",
    "retentionScore": 0-100,
    "funnyScore": 0-100,
    "payoffStrength": 0-100,
    "contextClarity": 0-100,
    "noveltyScore": 0-100,
    "shortsPotential": 0-100,
    "longFormPotential": 0-100,
    "transitionPotential": 0-100,
    "cooldownPotential": 0-100,
    "toxicityRisk": 0-100,
    "singingScore": 0-100,
    "dancingScore": 0-100,
    "rageScore": 0-100,
    "flags": [],
    "reasoning": "1 речення"
  },
  ...
]
```

**DDOS Score формула:**
```
viralityScore = min(100, sqrt(viralityRatio) * 35)
  // viralityRatio = view_count / hours_alive / avg_viewers (з TwitchTracker)

ddosScore =
  viralityScore  * 0.30
  + retentionScore * 0.25
  + funnyScore   * 0.20
  + payoffStrength * 0.15
  + contextClarity * 0.10
  - (toxicityRisk > 40 ? (toxicityRisk - 40) * 0.5 : 0)
```

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

## PEAK MOMENT — Знайти найгучніший 1-секундний момент

Для кожного кліпу після scoring:

```bash
ffprobe -v quiet -select_streams a:0 -show_entries stream=codec_type \
  "processed/<clipId>/clean.mp4" 2>/dev/null
```

Якщо аудіо трек відсутній → `peakMoment = {"start": 0, "end": 1.0, "rmsDb": -50}`, пропустити.

Інакше — запустити Python скрипт:

```bash
PEAK=$(python3 scripts/find_peak.py "processed/<clipId>/clean.mp4")
# Додати peakMoment в score.json
```

Зберегти `score.json`:
```json
{
  "...all score fields...",
  "peakMoment": {"start": 12.5, "end": 13.5, "rmsDb": -8.3}
}
```

---

## CHILL CLIP ACCUMULATION

Після scoring кожного кліпу:

```bash
if singingScore > 70:
  mkdir -p assets/chill-archive/singing
  cp "processed/<clipId>/clean.mp4" "assets/chill-archive/singing/<clipId>.mp4"
  # Додати в assets/chill-archive/index.json:
  {"clipId": "...", "type": "singing", "broadcaster": "...", "score": N, "runId": "...", "duration": N}

if dancingScore > 70:
  mkdir -p assets/chill-archive/dancing
  cp "processed/<clipId>/clean.mp4" "assets/chill-archive/dancing/<clipId>.mp4"
  # Аналогічно в index.json з type: "dancing"
```

---

## PLAN — Claude будує план епізоду

```bash
node scripts/progress.js "projects/<runId>" 6 "Будую план епізоду"
```

Передай топ-40 scored кліпів з реальними post-trim тривалостями. Claude вирішує план безпосередньо в розмові.

**Підготовка даних перед плануванням:**
```javascript
// Зчитати clean.mp4 тривалість для кожного кліпу з топ-40
const cleanDur = {};
scored.slice(0, 40).forEach(c => {
  const r = spawnSync('ffprobe', ['-v','quiet','-show_entries','format=duration',
    '-of','csv=p=0', path.join(projectDir,'processed',c.id,'clean.mp4')], {encoding:'utf8'});
  cleanDur[c.id] = parseFloat(r.stdout) || 0;
});
```

**Planning prompt:**
```
Ти директор епізоду "Daily Dose Of Stream" #<N>.

Кліпи (відсортовані за ddosScore, тривалість — після обрізки тиші):
<clipId | стрімер | категорія | ddosScore | funnyScore | rageScore | singingScore | dancingScore | shortsPotential | cleanDuration(s)>

ПРАВИЛА ГРУПУВАННЯ:
- GAME_GROUP: та сама гра, різні стрімери → підряд (до 5 кліпів)
- STREAMER_GROUP: той самий стрімер, та сама гра → підряд (до 3 кліпів)
- VIBE_GROUP: схожий тон chaos/wholesome/rage → підряд
- MICRO_GROUP: кліпи < 15с → збирати разом (до 6 кліпів) для динамічного ритму
- ЗАБОРОНЕНО: той самий стрімер + різна гра в одній групі

ПРАВИЛА ВИБОРУ:
- **ТРИВАЛІСТЬ** (головний критерій): сума cleanDuration вибраних кліпів = 720–900с (12–15 хв).
  До суми додай: intro 1.25с + (кількість груп - 1) × 1с reconnecting + outro 1.25с.
  Додавай кліпи поки не досягнеш мінімум 720с. Не виходь за 900с.
- **КАТЕГОРІЇ**: мінімум 50% кліпів мусять бути з Just Chatting (509658) або IRL (509672). Максимум 2 кліпи з однієї ігрової категорії.
- Перша група: сильний, захоплюючий контент (opener)
- **reconnectingClipId**: обирати кліп де є ЧІТКИЙ пік — раптова реакція, вигук, смішний момент в середині кліпу. Ідеально: кліп з `rageScore > 60` або `funnyScore > 75`. НЕ брати довгі спокійні кліпи.
- Chill фінал: якщо є кліпи з singingScore > 70 або dancingScore > 70 → ставити в кінець як `chillPlan`. Ці кліпи НЕ включати в основні групи — вони підуть через chill-finale.mp4.
- Обери 5–10 кліпів для Shorts (найвищий shortsPotential)

Відповідай ТІЛЬКИ JSON:
{
  "clipOrder": ["id1","id2",...],
  "groups": [
    {"type":"GAME_GROUP","label":"CS2 Chaos","clipIds":["id1","id2"],"tone":"chaotic"}
  ],
  "openerClipId": "id",
  "reconnectingClipId": "id",
  "chillPlan": {
    "type": "singing_then_dancing|dancing_montage|skip",
    "singingClipId": "id or null",
    "dancingClipIds": ["id1",...],
    "extractFromVod": false
  },
  "shortClipIds": ["id1",...],
  "reasoning": "..."
}
```

Зберегти у `edit/episode-plan.json` і `edit/shorts-selection.json`.
Оновити `state.stages.plan = "done"`.

---

## HOOKS — текстові хуки

```bash
node scripts/progress.js "projects/<runId>" 8 "Генерую хуки для кліпів"
```

Хуки генеруються **в розмові** (не через API виклик). Зчитай дані кліпів і згенеруй всі хуки одним батчем:

```bash
node scripts/gen-hooks.js "<runId>"
```

Скрипт виведе список кліпів без хуків (CACHED кліпи пропущені). Для кожного кліпу зі списку:
- Стиль: ALL CAPS, 2–5 слів, anticipation-based, сарказм, **без спойлерів**
- Приклади: `THIS LOOKED FINE AT FIRST` / `HE REALLY THOUGHT THIS WOULD WORK` / `WAIT FOR IT`

Зберегти кожен хук напряму через Write tool:
```
projects/<runId>/processed/<clipId>/hook.txt
```

**НЕ** викликати Anthropic API або будь-який зовнішній сервіс — хуки генеруються Claude безпосередньо в розмові.

Оновити `state.stages.score = "done"`, `state.stages.plan = "done"`, `state.stages.hooks = "done"`.
