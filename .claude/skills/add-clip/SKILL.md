# Команда: /add-clip

Додати один або кілька Twitch-кліпів вручну до активного run.

## Використання

```
/add-clip <url1> [url2 ...]
/add-clip <url> --run Episode_44_2026_06_28
```

## Що робить

```bash
node scripts/add-clip.js <url1> [url2 ...] [--run <runId>]
```

Витягує `clipId` зі slug-частини `/clip/SlugName`, запитує Twitch API,
завантажує через yt-dlp і додає до `downloaded-clips.json` поточного run.

## Логіка run

- За замовчуванням: знаходить найсвіжіший run де `status != "published"`
- `--run <runId>`: примусово до вказаного run
- Якщо активного run немає: створює `Manual_N_YYYY_MM_DD`

## Параметри

- `url1 url2 ...` — одне або кілька Twitch clip URL
- `--run <runId>` — явно вказати run (необов'язково)
