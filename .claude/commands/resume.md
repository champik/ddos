# Команда: /ddos resume

Продовжує pipeline з першого незавершеного stage.

## Виконання

1. Читай `projects/<runId>/state.json`
2. Знайди перший stage де status != "done"
3. Продовжуй pipeline з того stage
4. Використовуй той самий runId і episodeNumber
5. Не перезаписуй файли які вже існують (кешування)
