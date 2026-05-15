# Daily Dose Of Stream — Automated Pipeline

Автоматична система для YouTube каналу DDOS.  
Твіч кліпи → готовий епізод + Shorts + thumbnail.

## Як запустити

```bash
cd ddos/
claude
```

Потім у Claude Code:
```
/ddos run
```

Claude сам:
1. Підтягне кліпи з Twitch
2. Відфільтрує (без RU, gambling, сміття)
3. Завантажить через yt-dlp
4. Транскрибує через faster-whisper
5. Оцінить кожен кліп (DDOS Score)
6. Вирішить порядок епізоду
7. Обріже dead air
8. Згенерує хуки і субтитри
7. Накладе streamer overlay і RECONNECTING transition
8. Зберере long-form 1920×1080
9. Зробить 5–8 Shorts 1080×1920
10. Зробить thumbnail
11. Згенерує title/description/hashtags
12. Покаже review.html

Потім: `/ddos approve <runId>` → `/ddos upload <runId>`

## Setup (one-time)

### Залежності

```bash
# FFmpeg (вже встановлений)
ffmpeg -version

# yt-dlp
pip install yt-dlp

# Python транскрипція
pip install faster-whisper

# Node + Puppeteer (для thumbnail і overlays)
npm install puppeteer
```

### .env файл

Створи `.env` в папці ddos/:
```
TWITCH_CLIENT_ID=your_id
TWITCH_CLIENT_SECRET=your_secret
ANTHROPIC_API_KEY=your_key
YOUTUBE_CLIENT_ID=your_id (опціонально для upload)
YOUTUBE_CLIENT_SECRET=your_secret (опціонально)
NOTION_API_KEY=your_key (опціонально)
NOTION_DATABASE_ID=your_db_id (опціонально)
```

### Twitch API

1. Зайди на https://dev.twitch.tv/console
2. Register Your Application
3. Скопіюй Client ID і Secret в .env

## Команди

| Команда | Дія |
|---------|-----|
| `/ddos run` | Повний pipeline (24h) |
| `/ddos run --hours 48` | Pipeline за 48 годин |
| `/ddos run --dry-run` | Тест без завантаження |
| `/ddos resume <runId>` | Продовжити з зупинки |
| `/ddos status <runId>` | Статус pipeline |
| `/ddos approve <runId>` | Approve для upload |

## Структура проекту

```
ddos/
├── CLAUDE.md                    ← мозок системи
├── README.md
├── .env                         ← API ключі (не комітити)
├── .gitignore
├── .claude/
│   ├── commands/                ← /ddos run, /ddos approve, etc.
│   └── skills/                  ← логіка кожного етапу
├── brand/
│   └── ddos-rules.md            ← правила контенту
├── assets/
│   ├── intro/intro.mp4
│   ├── outro/outro.mp4
│   ├── overlays/reconnecting.html
│   ├── streamer-overlay/streamer_name.html
│   └── thumbnail-template/thumbnail.html + logo.svg
├── scripts/
│   ├── transcribe.py            ← faster-whisper
│   └── normalize.sh             ← FFmpeg audio normalize
└── projects/                    ← тут з'являються готові епізоди
```
