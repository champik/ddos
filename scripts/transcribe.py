import sys
import json
import os
from pathlib import Path

def transcribe(video_path, output_path, clip_id):
    out = Path(output_path)
    if out.exists():
        print(f"[SKIP] {clip_id} transcript already exists")
        return

    out.parent.mkdir(parents=True, exist_ok=True)

    try:
        from faster_whisper import WhisperModel
        model = WhisperModel("tiny", device="cpu", compute_type="int8")
        segments, info = model.transcribe(video_path, word_timestamps=True)

        words = []
        full_text = []
        for seg in segments:
            full_text.append(seg.text.strip())
            if seg.words:
                for w in seg.words:
                    words.append({"word": w.word, "start": round(w.start, 3), "end": round(w.end, 3)})

        result = {
            "clip_id": clip_id,
            "language": info.language,
            "duration": info.duration,
            "text": " ".join(full_text),
            "words": words
        }
        with open(out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"[OK] {clip_id}: {len(words)} words")

    except Exception as e:
        result = {"clip_id": clip_id, "error": str(e), "text": "", "words": []}
        with open(out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"[ERR] {clip_id}: {e}")

if __name__ == "__main__":
    transcribe(sys.argv[1], sys.argv[2], sys.argv[3])
