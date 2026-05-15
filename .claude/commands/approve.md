# Команда: /ddos approve <runId>

1. Прочитати `projects/<runId>/state.json`
2. Перевірити `state.outputs.youtubeVideoId` — якщо порожній, вивести помилку
3. Опублікувати відео:
   ```bash
   VIDEO_ID=<state.outputs.youtubeVideoId>
   node scripts/youtube-upload.js publish-video "$VIDEO_ID"
   ```
4. Оновити `state.status = "published"`, `state.approvedAt = <ISO datetime>`
5. Вивести: `Епізод #<N> опублікований: https://youtu.be/$VIDEO_ID`
