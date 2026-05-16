# Skill: ddos-shorts

Згенеруй ASS субтитри і відрендери вертикальні Shorts.

---

## CAPTIONS — ASS субтитри

Субтитри генеруються скриптом `gen-captions.js` (вже частина CAPTIONS стадії в ddos-render).

Формати що генерує скрипт:
- `captions-longform.ass` — тільки емоційні фрази, Impact 72px, жовтий `#f5ff3d`, 1920×1080
- `captions-vertical.ass` — всі фрази, word-by-word progressive reveal, Impact 82px, 1080×1920

**ВАЖЛИВО — Кольори ASS:**
- Жовтий `#f5ff3d` = `&H003DFFF5` (ASS BGR порядок, НЕ `&H00F5FF3D` — це буде блакитний)
- Білий `#f4f0e6` = `&H00E6F0F4`

Hot слова (стиль Hot = білий в шортах для контрасту): no, bro, what, wait, oh, stop, go, yes, wtf, literally, insane, crazy, nah, dude, man, guys, let, come, look, watch

---

## RENDER SHORTS — 1080×1920 Background Blur (без чорних смуг)

```bash
node scripts/render-shorts.js "projects/<runId>"
```

Скрипт:
- Читає `edit/shorts-selection.json` → `shortClipIds`
- Input: `processed/<clipId>/overlayed.mp4`
- Captions: `processed/<clipId>/captions-vertical.ass` (якщо існує)
- Layout: blurred background (1080×1920) + centered 1080px wide fg + ASS captions burn
- Output: `exports/shorts/<clipId>.mp4`

Обробляє Windows path escaping для ASS filter автоматично.

Зберегти список у `state.outputs.shortsPaths`.
Оновити `state.stages.renderShorts = "done"`.
