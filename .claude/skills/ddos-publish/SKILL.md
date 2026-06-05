# Skill: ddos-publish

Завантаж відео і шортси на YouTube.

---

## Перевірки перед upload

1. `state.stages.review == "done"` — інакше СТОП
2. `exports/episode-NNN.mp4` існує — інакше СТОП
3. `exports/thumbnail.png` існує — інакше СТОП
4. `auth/client_secret.json` існує — інакше вивести інструкцію:
   ```
   Щоб отримати client_secret.json:
   1. console.cloud.google.com → новий проект
   2. APIs & Services → Enable → "YouTube Data API v3"
   3. Credentials → Create → OAuth 2.0 → Desktop app
   4. Download → зберегти як auth/client_secret.json
   ```

---

## UPLOAD MAIN VIDEO

```bash
node scripts/youtube-upload.js upload-video \
  "<runId>" \
  "projects/<runId>/exports/metadata.json" \
  "projects/<runId>/exports/episode-<N>.mp4" \
  "projects/<runId>/exports/thumbnail.png"
```

При першому запуску відкриється браузер для авторизації. Далі — автоматично.

Зберегти повернутий videoId. Оновити `state.outputs.youtubeVideoId`.

---

## PUBLISH ALL (рекомендований шлях)

Одна команда: публікує основне відео зараз + планує шортси через кожну годину.

```bash
node scripts/youtube-upload.js publish-all "<runId>"
```

Або із запланованим часом публікації основного відео:

```bash
node scripts/youtube-upload.js publish-all "<runId>" "2026-05-16T18:00:00.000Z"
```

Що відбувається:
1. Основне відео (вже завантажене як unlisted) → виставляється як **public** зараз або за розкладом
2. Кожен шортс з `episode-plan.json.shortClipIds` завантажується зі статусом `private + publishAt`
   - Short #1 → mainPublishTime + 1 год
   - Short #2 → mainPublishTime + 2 год
   - Short #3 → mainPublishTime + 3 год
   - ...
3. Description кожного шортса:
   ```
   Full episode ▶ https://youtu.be/<mainVideoId>
   
   <caption з metadata.json>
   
   #DailyDoseOfStream #TwitchClips #Shorts
   ```
4. Title береться з `metadata.json.shortsMetadata[clipId].title`
5. Зберігає `state.publishedAt` і `state.outputs.youtubeShortsIds[]`

---

## UPLOAD SHORTS (вручну, окремо)

```bash
node scripts/youtube-upload.js upload-short \
  "<runId>" "<clipId>" \
  "projects/<runId>/exports/shorts/<clipId>.mp4" \
  "<mainVideoId>" \
  "" \
  "2026-05-16T19:00:00.000Z"   # publishAt (опціонально)
```

Без publishAt — публікується одразу як Public.

---

## Команда `/approve`

Обробляється в `.claude/commands/approve.md`. Приймає JSON з `title` і `thumbnail`. Після approve:

**ВАЖЛИВО — перед заміною thumbnail.png зберегти оригінал:**
```bash
cp "projects/<runId>/exports/thumbnail.png" "projects/<runId>/exports/thumbnail-v1.png"
```
Це зберігає Puppeteer V1 як `thumbnail-v1.png` — він буде показуватись у review як V1.
Після цього — копіювати обраний варіант (v2/v3) на `thumbnail.png` для upload.

```bash
node scripts/youtube-upload.js publish-all "<runId>" "" "<selectedTitle>"
```

Оновити `state.status = "published"`.
Вивести:
```
✅ Епізод #N опублікований: https://youtu.be/<videoId>
📱 Shorts заплановані: +1год, +2год, +3год...
```

Після publish — оновити review і index:

```bash
node scripts/gen-review.js "projects/<runId>"
node scripts/update-index.js "<runId>"
```

`gen-review.js` — оновить статус на "✓ Published", додасть YouTube + Shorts лінки під заголовком review.html.  
`update-index.js` — в `projects/index.html` змінить статус на "✓ published". **ТІЛЬКИ** кнопки Review і Edit — ніяких YouTube ↗ або Shorts ↗ в index.html.
