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

## RENDER SHORTS — три режими

```bash
node scripts/render-shorts.js "projects/<runId>"
```

Скрипт читає `edit/editorial.json` і будує список shorts:
```javascript
const shortClips = editorial.clipOrder
  .filter(id => editorial.clips?.[id]?.short)
  .map(id => ({ id, ...editorial.clips[id].short }));
```

Також читає `edit/shorts-selection.json` як fallback якщо editorial.json відсутній.

Input: `processed/<clipId>/clean.mp4` (без стрімер-оверлею)
Output: `exports/shorts/<clipId>.mp4`

Брендинг через оверлей відсутній — тільки субтитри внизу.

### Режим: desktop (blur зверху/знизу)
```bash
ffmpeg -i "processed/<id>/clean.mp4" \
  -filter_complex \
  "[0:v]split[main][bg];
   [bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5,eq=brightness=-0.3[blurred];
   [main]scale=1080:-2[fg];
   [blurred][fg]overlay=(W-w)/2:(H-h)/2,ass=processed/<id>/captions-vertical.ass[out_sar];
   [out_sar]setsar=1[out]" \
  -map "[out]" -map "0:a" \
  -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -ac 2 -ar 48000 \
  -movflags +faststart -y "exports/shorts/<id>.mp4"
```
Якщо `captions-vertical.ass` відсутній — прибрати `,ass=...` з останнього фільтру.

### Режим: mobile (center crop 9:16)
```bash
ffmpeg -i "processed/<id>/clean.mp4" \
  -filter_complex \
  "[0:v]crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920,ass=processed/<id>/captions-vertical.ass[out_sar];
   [out_sar]setsar=1[out]" \
  -map "[out]" -map "0:a" \
  -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -ac 2 -ar 48000 \
  -movflags +faststart -y "exports/shorts/<id>.mp4"
```

### Режим: split (webcam + gameplay)
Параметри з `editorial.clips[id].short`:
- `webcam: [x, y, w, h]` — координати в частках (0–1) відносно 1920×1080
- `camPos: "top" | "bottom"` — вебка зверху чи знизу (default: top)

```javascript
// Абсолютні пікселі з відносних координат
const [rx, ry, rw, rh] = short.webcam;
const CAM_X = Math.round(rx * 1920);
const CAM_Y = Math.round(ry * 1080);
const CAM_W = Math.round(rw * 1920);
const CAM_H = Math.round(rh * 1080);

const CAM_OUT_H  = camNaturalH; // визначається з AR + camCrop
const GAME_OUT_H = 1920 - CAM_OUT_H;

// camPos=top: webcam зверху, gameplay знизу
const order = (short.camPos === 'bottom') ? '[game][cam]' : '[cam][game]';
```

```bash
ffmpeg -i "processed/<id>/clean.mp4" \
  -filter_complex \
  "[0:v]split=2[vsrc1][vsrc2];
   [vsrc1]crop=${CAM_W}:${CAM_H}:${CAM_X}:${CAM_Y},scale=1080:${CAM_OUT_H}[cam];
   [vsrc2]crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920,crop=1080:${GAME_OUT_H}:0:${gameOffset}[game];
   ${order}vstack=inputs=2,ass=processed/<id>/captions-vertical.ass[out_sar];
   [out_sar]setsar=1[out]" \
  -map "[out]" -map "0:a" \
  -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -ac 2 -ar 48000 \
  -movflags +faststart -y "exports/shorts/<id>.mp4"
```

Зберегти список у `state.outputs.shortsPaths`.
Оновити `state.stages.renderShorts = "done"`.
