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

Input: `processed/<clipId>/overlayed.mp4`
Output: `exports/shorts/<clipId>.mp4`

### Режим: desktop (blur зверху/знизу)
```bash
ffmpeg -i "processed/<id>/overlayed.mp4" \
  -filter_complex \
  "[0:v]scale=1080:1920,boxblur=20:5[bg];
   [0:v]scale=1080:-2[fg];
   [bg][fg]overlay=(W-w)/2:(H-h)/2[out];
   [out]subtitles=processed/<id>/captions-vertical.ass[final]" \
  -map "[final]" -map "0:a" \
  -c:v libx264 -crf 23 -c:a aac -b:a 192k -ac 2 -ar 48000 -r 30 \
  -y "exports/shorts/<id>.mp4"
```
Якщо `captions-vertical.ass` відсутній — прибрати `subtitles=` фільтр (замінити `[out]` на output напряму).

### Режим: mobile (center crop 9:16)
```bash
ffmpeg -i "processed/<id>/overlayed.mp4" \
  -vf "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920" \
  -c:v libx264 -crf 23 -c:a aac -b:a 192k -ac 2 -ar 48000 -r 30 \
  -y "exports/shorts/<id>.mp4"
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

const CAM_OUT_H = 726;   // 1920 * 0.38
const GAME_OUT_H = 1191; // 1920 - 3 - 726

// camPos=top: webcam зверху, gameplay знизу
// [cam][game]vstack → якщо camPos=bottom то [game][cam]vstack
const order = (short.camPos === 'bottom') ? '[game][cam]' : '[cam][game]';
```

```bash
ffmpeg -i "processed/<id>/overlayed.mp4" \
  -filter_complex \
  "[0:v]crop=${CAM_W}:${CAM_H}:${CAM_X}:${CAM_Y},scale=1080:${CAM_OUT_H}[cam];
   [0:v]scale=1080:${GAME_OUT_H}[game];
   ${order}vstack=inputs=2[out]" \
  -map "[out]" -map "0:a" \
  -c:v libx264 -crf 23 -c:a aac -b:a 192k -ac 2 -ar 48000 -r 30 \
  -y "exports/shorts/<id>.mp4"
```

Зберегти список у `state.outputs.shortsPaths`.
Оновити `state.stages.renderShorts = "done"`.
