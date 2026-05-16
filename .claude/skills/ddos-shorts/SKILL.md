# Skill: ddos-shorts

Згенеруй ASS субтитри і відрендери вертикальні Shorts.

---

## CAPTIONS — ASS субтитри для шортсів

Виконується тут (в ddos-shorts), після того як shortClipIds вже відомі з episode-plan.json.
Генерується тільки `captions-vertical.ass` для кожного short кліпу — НЕ для всього епізоду.

```bash
node scripts/gen-captions.js "projects/<runId>" --shorts-only
```

Що генерує:
- `processed/<clipId>/captions-vertical.ass` для кожного clipId з `plan.shortClipIds`
- Word-by-word progressive reveal, Impact 82px, 1080×1920
- **НЕ** генерує `episode.ass` — longform відео завжди без субтитрів

**ВАЖЛИВО — Кольори ASS:**
- Жовтий `#f5ff3d` = `&H003DFFF5` (ASS BGR порядок, НЕ `&H00F5FF3D` — це буде блакитний)
- Білий `#f4f0e6` = `&H00E6F0F4`

Hot слова (стиль Hot = білий для контрасту): no, bro, what, wait, oh, stop, go, yes, wtf, literally, insane, crazy, nah, dude, man, guys, let, come, look, watch

Якщо transcript.json відсутній для кліпу → short рендериться без субтитрів.

Оновити `state.stages.captions = "done"`.

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
