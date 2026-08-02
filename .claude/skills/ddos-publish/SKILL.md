# Skill: ddos-publish

Завантаж відео і шортси на YouTube. **Selection-only pipeline:** фінальний монтаж відбувається
в CapCut — `exports/episode.mp4` і `exports/shorts/*.mp4` система сама не створює, користувач
кладе туди готовий експорт із CapCut ПЕРЕД тим як запускати approve.

---

## Перевірки перед upload

1. `state.stages.review == "done"` — інакше СТОП
2. `exports/episode.mp4` існує — інакше СТОП з підказкою "експортуй з CapCut у exports/episode.mp4"
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
  "<projectDir>/exports/metadata.json" \
  "<projectDir>/exports/episode.mp4" \
  "<projectDir>/exports/thumbnail.png"
```

При першому запуску відкриється браузер для авторизації. Далі — автоматично.

Зберегти повернутий videoId. Оновити `state.outputs.youtubeVideoId`.

---

## PUBLISH ALL (рекомендований шлях)

```bash
node scripts/youtube-upload.js publish-all "<runId>" "<publishAtISO>" "<selectedTitle>"
```

Що відбувається:
1. Основне відео → public зараз або за розкладом
2. Шортси з `shortClipIds` → `private + publishAt` (+2год, +4год, +6год...)
3. Зберігає `state.publishedAt` і `state.outputs.youtubeShortsIds[]`

---

## UPLOAD SHORTS (вручну, окремо)

```bash
node scripts/youtube-upload.js upload-short \
  "<runId>" "<clipId>" \
  "<projectDir>/exports/shorts/<clipId>.mp4" \
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
cp "<projectDir>/exports/thumbnail.png" "<projectDir>/exports/thumbnail-v1.png"
```
Це зберігає Puppeteer V1 як `thumbnail-v1.png` — він буде показуватись у review як V1.
Після цього — копіювати обраний варіант (v2/v3) на `thumbnail.png` для upload.

Розрахувати час публікації — 15:15 Київ (UTC+3 = 12:15 UTC). Якщо вже минув — порожній рядок (публікувати зараз):
```bash
PUBLISH_AT=$(node -e "
  const now = new Date();
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 15));
  console.log(t > now ? t.toISOString() : '');
")
node scripts/youtube-upload.js publish-all "<runId>" "$PUBLISH_AT" "<selectedTitle>"
```

**ВАЖЛИВО:**ніколи не передавати `""` буквально — це означає "опублікувати негайно".

Оновити `state.status = "published"`.
Вивести:
```
✅ Епізод #N опублікований: https://youtu.be/<videoId>
📱 YouTube Shorts заплановані: +2год, +4год, +6год...
```

Після publish — оновити review і index:

```bash
node scripts/gen-review.js "<projectDir>"
node scripts/update-index.js "<runId>"
```

`<projectDir>` = `projects/<YYYY_MM_Month>/<runId>` (напр. `projects/2026_06_June/Episode_44_2026_06_28`).

`gen-review.js` — оновить статус на "✓ Published", додасть YouTube + Shorts лінки під заголовком review.html.  
`update-index.js` — в `projects/index.html` змінить статус на "✓ published". **ТІЛЬКИ** кнопки Review і Edit — ніяких YouTube ↗ або Shorts ↗ в index.html.
