#!/usr/bin/env bash
# normalize.sh — нормалізує аудіо кліпу (EBU R128)
# Usage: ./scripts/normalize.sh <input.mp4> <output.mp4>
set -euo pipefail

IN="${1:?Usage: normalize.sh <input> <output>}"
OUT="${2:?Usage: normalize.sh <input> <output>}"
mkdir -p "$(dirname "$OUT")"

HAS_AUDIO=$(ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$IN" 2>/dev/null || true)

if [ -n "$HAS_AUDIO" ]; then
  ffmpeg -y -i "$IN" \
    -af "loudnorm=I=-16:TP=-1.5:LRA=11" \
    -c:v copy \
    "$OUT"
else
  # Додати тишу якщо немає аудіо
  ffmpeg -y -i "$IN" \
    -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000" \
    -c:v copy -c:a aac -b:a 192k \
    -shortest "$OUT"
fi

echo "✓ normalized: $OUT"
