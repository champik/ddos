# Skill: ddos-shorts

Згенеруй ASS субтитри і відрендери вертикальні Shorts.

---

## CAPTIONS — ASS субтитри

### Long-form (selective — тільки емоційні моменти)

Для кожного кліпу читай transcript.json.
Позначай сегмент як highlight якщо він містить: bro, no way, what, oh my, let's go, insane, crazy, wtf, holy, wait — або весь текст великими літерами.

Формат ASS для long-form (`captions-longform.ass`):
```
[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, Outline, Alignment, MarginV
Style: Default,Archivo Black,56,&H00F4F0E6,&H000E0E10,-1,3,2,80

[Events]
Format: Layer, Start, End, Style, Text
```

Для кожного highlight слова:
```
Dialogue: 0,0:00:01.20,0:00:01.50,Default,,0,0,0,,{\an2}СЛОВО
```

Тільки highlighted сегменти. Word-by-word timing з transcript.

### Shorts (full — всі слова, агресивний стиль)

Формат ASS для shorts (`captions-vertical.ass`):
```
[Script Info]
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Style: Default,Archivo Black,72,&H00FFFFFF,&H000E0E10,-1,4,2,300
Style: Hot,Archivo Black,72,&H00F5FF3D,&H000E0E10,-1,4,2,300
```

Hot слова (жовті): no, bro, what, wait, oh, stop, go, yes, wtf, literally, insane, crazy, nah, bro

Кожне слово окремою строкою з word-level timestamp.

---

## RENDER SHORTS — 1080×1920 Background Blur (без чорних смуг)

Для кожного clipId з `edit/shorts-selection.json`:

```bash
INPUT="processed/<clipId>/clean.mp4"
CAPTIONS="processed/<clipId>/captions-vertical.ass"

# Побудова caption filter (порожній якщо файл відсутній)
if [ -f "$CAPTIONS" ]; then
  CAPTION_FILTER=",ass=${CAPTIONS}"
else
  CAPTION_FILTER=""
fi

ffmpeg -i "$INPUT" \
  -filter_complex "
    [0:v]split[main][bg];
    [bg]scale=1080:1920:force_original_aspect_ratio=increase,
        crop=1080:1920,
        boxblur=20:5,
        eq=brightness=-0.3[blurred];
    [main]scale=1080:608[fg];
    [blurred][fg]overlay=(W-w)/2:(H-h)/2${CAPTION_FILTER}[out]
  " \
  -map "[out]" -map "0:a" \
  -c:v libx264 -preset fast -crf 24 \
  -c:a aac -b:a 128k -ar 48000 \
  -movflags +faststart \
  -y "exports/shorts/<clipId>.mp4"
```

Якщо NVENC доступний: замінити `-c:v libx264 -preset fast -crf 24` на `-c:v h264_nvenc -preset p4 -cq 24`.

Зберегти список у `state.outputs.shortsPaths`.
Оновити `state.stages.renderShorts = "done"`.
