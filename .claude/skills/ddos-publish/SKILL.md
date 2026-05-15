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

## UPLOAD SHORTS

`state.outputs.shortsPaths` містить список шляхів до файлів (наприклад `exports/shorts/<clipId>.mp4`).
Для кожного елементу витягни clipId через `basename "$SHORT_PATH" .mp4`:

```bash
SHORT_PATH="exports/shorts/<clipId>.mp4"
CLIP_ID=$(basename "$SHORT_PATH" .mp4)
HOOK=$(cat "projects/<runId>/processed/$CLIP_ID/hook.txt" 2>/dev/null || echo "CLIP")
MAIN_ID=$(node -e "const s=require('projects/<runId>/state.json'); console.log(s.outputs.youtubeVideoId||'')")

node scripts/youtube-upload.js upload-short \
  "<runId>" \
  "<clipId>" \
  "projects/<runId>/exports/shorts/<clipId>.mp4" \
  "$MAIN_ID" \
  "$HOOK"
```

Шортси публікуються одразу як Public і лінкуються на основне відео.

Оновити `state.stages.publish = "done"`.

---

## Команда `/ddos approve <runId>`

Обробляється в `.claude/commands/approve.md`. Після approve:

```bash
VIDEO_ID=$(node -e "const s=require('projects/<runId>/state.json'); console.log(s.outputs.youtubeVideoId)")
node scripts/youtube-upload.js publish-video "$VIDEO_ID"
```

Оновити `state.status = "published"`.
Вивести: `✅ Епізод #N опублікований: https://youtu.be/$VIDEO_ID`
