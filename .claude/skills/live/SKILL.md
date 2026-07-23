# Команда: /live

Перевіряє хто з епізодних стрімерів зараз онлайн на Twitch.

## Використання

```
/live          — хто онлайн з останніх 7 епізодів
/live 35       — хто онлайн з конкретного епізоду #35
```

## Що виконати

```bash
# з кореня репозиторію
node scripts/live-check.js <N> --json
```

Де `<N>` — номер епізоду з аргументу команди, або нічого якщо без аргументу.

Отримані JSON дані форматуй як markdown таблицю у чаті:

| Стрімер | Глядачі | Категорія | Кліпи з епізоду |
|---|---|---|---|
| Name | 12 345 | Game Name | [🟣](url1) hook1  [🟣](url2) hook2 |

- Стовпець "Кліпи" — для кожного кліпу: іконка `[🟣](clip_url)` + hook текст, через два пробіли якщо кліпів декілька
- Якщо стрімер є у кількох епізодах — окремий рядок на кожен епізод, стовпці Стрімер/Глядачі/Категорія порожні з другого рядка
- Якщо ніхто не онлайн — написати просто: "Ніхто з епізоду #N зараз не стрімить."

## Приклад виводу

```
Перевіряю 47 стрімерів з 7 епізодів...

🔴 Онлайн з останніх 7 епізодів (ep#29–#35) — 3 з 47:

xQc  —  Just Chatting  [85 432 глядачів]
  twitch.tv/xqc
  Ep#35: 1 кліп
    • "xQc and CYR chefs"  [Just Chatting — 120 000 views]

IShowSpeed  —  FIFA 26  [42 100 глядачів]
  twitch.tv/ishowspeed
  Ep#35: 1 кліп
    • "IShowSpeed met Ronaldo rival"  [Just Chatting — 95 000 views]

ohnePixel  —  Counter-Strike 2  [12 800 глядачів]
  twitch.tv/ohnepixel
  Ep#34: 1 кліп
    • "ohnePixel stage 3"  [Counter-Strike 2 — 55 000 views]
```

## Логіка

1. Читає `projects/<YYYY_Month>/Episode_N_*/edit/episode-plan.json` (clipOrder)
2. Читає `clips/downloaded-clips.json` → broadcaster_name для кожного використаного кліпу
3. Читає `exports/metadata.json` → clipHooks для відображення хуків
4. Звертається до Twitch API `/helix/streams` з усіма логінами
5. Виводить тільки тих хто live, відсортованих по viewer_count (найбільше — перше)
