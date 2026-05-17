# Команда: /ddos approve <runId>

1. Прочитати `projects/<runId>/state.json`
2. Перевірити `state.outputs.youtubeVideoId` — якщо порожній, вивести помилку
3. Опублікувати відео:
   ```bash
   VIDEO_ID=<state.outputs.youtubeVideoId>
   node scripts/youtube-upload.js publish-video "$VIDEO_ID"
   ```
4. Оновити `state.status = "published"`, `state.approvedAt = <ISO datetime>`
5. Оновити `projects/index.html` для цього епізоду:
   - Знайти картку з `EP #N` (де N = episodeNumber)
   - Замінити `status-pending">⏳ pending` → `status-published">✓ published`
   - В `.links-row` після кнопки Review додати YouTube кнопку:
     ```html
     <a class="btn btn-youtube" href="https://www.youtube.com/watch?v=<VIDEO_ID>" target="_blank">YouTube ↗</a>
     ```
   - Якщо є `youtubeShortsIds` у state.outputs — додати кнопки для кожного short:
     ```html
     <a class="btn btn-shorts" href="https://www.youtube.com/shorts/<shortId>" target="_blank">Short N ↗</a>
     ```
6. Вивести: `Епізод #<N> опублікований: https://youtu.be/$VIDEO_ID`
