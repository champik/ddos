# Команда: /ddos status

Показати статус всіх stages для запуску.

## Використання
```
/ddos status <runId>
```
Без `<runId>` — показати останній активний (не `published`) запуск: перебрати
`findAllProjects()` (`scripts/lib/project-path.js`), взяти найновіший за `startedAt`
у `state.json`, чий `status !== "published"`.

## Виконання

1. Знайти `projectDir` через `getProjectDir(runId)` (`scripts/lib/project-path.js`).
2. Прочитати `<projectDir>/state.json`. Якщо файл відсутній — повідомити
   `Запуск <runId> не знайдено` і зупинитись.
3. Вивести:

```
Статус: <runId> (episode #<episodeNumber>)
Загальний статус: <status>   Розпочато: <startedAt>

Стадії:
  ✓ ingest                done
  ✓ filter                done
  ✓ select                done
  ✓ download              done
  ✓ gaming_screen         done
  ✓ generate_editorial    done
  ⏳ editorial             pending
  ...
```

Позначення: `✓` = done, `⚠` = done_with_errors, `✗` = failed, `▶` = running, `⏳` = pending.

Якщо `state.warnings` непорожній — вивести окремим блоком:
```
Попередження:
  - <warning 1>
  - <warning 2>
```

Якщо `state.stages` містить `"failed"` — після таблиці підказати:
`Продовжити: /ddos resume <runId>` (якщо зупинка до editorial) або конкретний
скрипт, що впав (дивись `stages.*` ключ і відповідний skill: `ddos-ingest`,
`ddos-render`, `ddos-shorts`, `ddos-thumbnail`, `ddos-youtube-creatives`, `ddos-review`, `ddos-publish`).
