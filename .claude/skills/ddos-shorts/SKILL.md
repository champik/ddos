# Skill: ddos-shorts — ВИМКНЕНО (CapCut)

**Selection-only pipeline:** CAPTIONS і RENDER SHORTS більше не виконуються системою.
Користувач сам ріже Shorts і додає субтитри в CapCut, з `processed/overlayed/*.mp4` —
див. `docs/superpowers/specs/2026-08-02-capcut-handoff-design.md`. `gen-captions.js` і
`render-shorts.js` лишились на диску (не викликаються).

METADATA (`ddos-youtube-creatives`) досі генерує `shortsMetadata` (title/description/hashtags
per short) для довідки при ручній публікації — тільки `shortIntros` (intro-хук для burned-in
тексту, який раніше рендерив `render-shorts.js`) прибрано, він нікому вже не потрібен.

Довідка нижче (як це працювало раніше) не виконується, лишена як контекст.

---

## CAPTIONS — ASS субтитри для шортсів

Виконується тут (в ddos-shorts), після того як shortClipIds вже відомі з episode-plan.json.
Генерується тільки `captions-vertical.ass` для кожного short кліпу — НЕ для всього епізоду.

```bash
node scripts/gen-captions.js "<projectDir>" --shorts-only
```

Що генерує:
- `processed/<clipId>/captions-vertical.ass` для кожного clipId з `plan.shortClipIds`
- Word-by-word progressive reveal, Impact 82px, 1080×1920
- **НЕ** генерує `episode.ass` — longform відео завжди без субтитрів

**ВАЖЛИВО — Кольори ASS:**
- Жовтий `#f5ff3d` = `&H003DFFF5` (ASS BGR порядок, НЕ `&H00F5FF3D` — це буде блакитний)
- Білий `#f4f0e6` = `&H00E6F0F4`

Профанність (Tier 1 матюки + Tier 2 слюри, список — `scripts/lib/profanity.js`)
маскується в тексті капшенів: перша+остання літера лишаються, середина — зірочки
(`fuck` → `f**k`). Це та сама цензура, що йде в аудіо через `apply-censor.js` —
слово вже вирізане з доріжки на цьому моменті, капшен більше не має його показувати.

Додатково: слова на **криках** автоматично отримують КАПС + scale-pop анімацію
(100%→107% за 90мс). Детект крику:
- гучність — з `transcript.json → vocals_rms`: чистий вокал після demucs, тому
  гучний геймплей/музика НЕ тригерять капс (fallback: RMS повного міксу clean.mp4)
- поріг: медіана +8dB, і тільки якщо динаміка кліпу ≥8dB (рівне аудіо = без капсу)
- плюс локальна виразність: слово має бути сплеском ≥3dB відносно сусідніх ±1с —
  просто гучна розмова капс не вмикає
- капс розповзається на всю фразу лише якщо гучних слів ≥2 або ≥половини фрази

Якщо transcript.json відсутній для кліпу → short рендериться без субтитрів.

Оновити `state.stages.captions = "done"`.

---

## RENDER SHORTS — три режими

**Залежність:** `exports/metadata.json` з заповненим `shortIntros` (генерується `ddos-youtube-creatives`,
Stage 12) повинен існувати ДО цього кроку. Скрипт читає intro-хук з нього мовчки — якщо файл/поле
відсутні, шорт рендериться без intro overlay і це не повертає помилку. Якщо METADATA ще не виконана —
виконати її першою.

```bash
node scripts/render-shorts.js "<projectDir>"
```

Скрипт читає `edit/editorial.json` і будує список shorts:
```javascript
const shortClips = editorial.clipOrder
  .filter(id => editorial.clips?.[id]?.short)
  .map(id => ({ id, short: editorial.clips[id].short }));
```

Input: `processed/<clipId>/clean.mp4`
Output: `exports/shorts/<clipId>.mp4`

**Auto punch-in:** скрипт знаходить найгучніший момент кліпу (RMS-аналіз) і додає
мʼякий zoom 6% (in 0.35s → hold ~1.4s → out 0.35s) на основний відеоряд.
Якщо пік не виділяється над медіаною ≥4dB — панч не застосовується.
Вимкнути per-clip: `editorial.clips[id].short.punchIn = false`.

**Новий формат `short` об'єкта** (з editorial.json):
```javascript
{
  mode: 'desktop' | 'mobile' | 'split',
  desktop: { x, y, w, h },   // % від кадру, 16:9 locked
  mobile:  { x, y, w, h },   // % від кадру, 9:16 locked
  split: {
    gameplay: { x, y, w, h },  // % від кадру
    webcam:   { x, y, w, h },  // % від кадру
    ratio: 0.7                 // частка висоти 1920px для gameplay (0.1–0.9)
  }
}
```

**Конвертація % → FFmpeg пікселі** (source 1920×1080):
```javascript
function toPx(crop, vw=1920, vh=1080) {
  return {
    x: Math.round(crop.x / 100 * vw),
    y: Math.round(crop.y / 100 * vh),
    w: Math.round(crop.w / 100 * vw),
    h: Math.round(crop.h / 100 * vh)
  };
}
```

### Режим: desktop — crop вибраної 16:9 зони + blur фон
```javascript
const c = toPx(short.desktop || { x:0, y:0, w:100, h:100 });
const ASS = fs.existsSync(`processed/${id}/captions-vertical.ass`)
  ? `,ass=processed/${id}/captions-vertical.ass` : '';
```
```bash
ffmpeg -i "processed/<id>/clean.mp4" \
  -filter_complex \
  "[0:v]crop=${c.w}:${c.h}:${c.x}:${c.y},split[main][bg];
   [bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5,eq=brightness=-0.3[blurred];
   [main]scale=1080:-2[fg];
   [blurred][fg]overlay=(W-w)/2:(H-h)/2${ASS}[out_sar];
   [out_sar]setsar=1[out]" \
  -map "[out]" -map "0:a" \
  -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -ac 2 -ar 48000 \
  -movflags +faststart -y "exports/shorts/<id>.mp4"
```

### Режим: mobile — crop вибраної 9:16 зони
```javascript
const c = toPx(short.mobile || { x:34.18, y:0, w:31.64, h:100 });
```
```bash
ffmpeg -i "processed/<id>/clean.mp4" \
  -filter_complex \
  "[0:v]crop=${c.w}:${c.h}:${c.x}:${c.y},scale=1080:1920${ASS}[out_sar];
   [out_sar]setsar=1[out]" \
  -map "[out]" -map "0:a" \
  -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -ac 2 -ar 48000 \
  -movflags +faststart -y "exports/shorts/<id>.mp4"
```

### Режим: split — gameplay зверху, webcam знизу
```javascript
const sp = short.split;
const g = toPx(sp.gameplay);
const w = toPx(sp.webcam);
const ratio = sp.ratio ?? 0.7;
const GAME_H = Math.round(1920 * ratio);
const CAM_H  = 1920 - GAME_H;
```
```bash
ffmpeg -i "processed/<id>/clean.mp4" \
  -filter_complex \
  "[0:v]split=2[vsrc1][vsrc2];
   [vsrc1]crop=${g.w}:${g.h}:${g.x}:${g.y},scale=1080:${GAME_H}[game];
   [vsrc2]crop=${w.w}:${w.h}:${w.x}:${w.y},scale=1080:${CAM_H}[cam];
   [cam][game]vstack=inputs=2${ASS}[out_sar];
   [out_sar]setsar=1[out]" \
  -map "[out]" -map "0:a" \
  -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -ac 2 -ar 48000 \
  -movflags +faststart -y "exports/shorts/<id>.mp4"
```

Зберегти список у `state.outputs.shortsPaths`.
Оновити `state.stages.renderShorts = "done"`.
