# Команда: /ddos approve

Апрувить run для upload на YouTube.

## Виконання

1. Читай `projects/<runId>/state.json`
2. Перевір що stage "review" == "done"
3. Якщо ні — повідомити: "Спочатку дочекайся завершення pipeline"
4. Встанови `state.status = "approved"`
5. Збережи state.json
6. Вивести:
```
✓ Run <runId> approved

Завантажити на YouTube: /ddos upload <runId>
```
