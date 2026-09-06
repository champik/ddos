# Команда: /ddos resolve

Автоматизує частину монтажу в DaVinci Resolve — деталі й межу автоматизація/вручну
дивись `docs/superpowers/specs/2026-09-06-davinci-resolve-integration-design.md`.

## /ddos resolve assemble <runId>

Складає Resolve-проєкт з `processed/clean/*.mp4` + `processed/streamers_name/*.png` у
порядку `editorial.json.clipOrder`, з intro/outro і overlay-позиціонуванням. Вимагає
відкритий DaVinci Resolve (без авто-запуску застосунку).

```bash
node scripts/resolve-assemble.js "<runId>"
```

Якщо таймлайн `Episode` вже існує в проєкті — команда відмовляється його перезбирати
без `--force`. З `--force` старий таймлайн перейменовується (`Episode_backup_<timestamp>`),
не видаляється — ручний монтаж, який там уже є, не втрачається.

```bash
node scripts/resolve-assemble.js "<runId>" --force
```

Перед першим реальним запуском на конкретному епізоді можна перевірити план без
дотику до Resolve:

```bash
node scripts/resolve-assemble.js "<runId>" --dry-run
```

Після успішного `assemble` — переказати користувачу останній рядок виводу
(`[VERIFY] check overlay position...`) і нагадати перевірити позицію/розмір overlay
на першому кліпі в Resolve, перш ніж різати кліпи далі.

## /ddos resolve chapters <runId>

Запускати ПІСЛЯ того, як користувач вручну поріз кліпи в Resolve (таймкоди рахуються
з поточного, вже зміненого стану таймлайну — не з моменту assemble).

```bash
node scripts/resolve-chapters.js "<runId>"
```

Пише `<projectDir>/exports/chapters.txt`, готовий вставити в опис YouTube вручну.
Якщо команда впала з `no clips matched on the timeline` — таймлайн у Resolve або
порожній, або всі кліпи перейменовано так, що вони більше не матчаються на
`NN_streamer_idSuffix`; повідомити користувачу і не писати порожній файл.
