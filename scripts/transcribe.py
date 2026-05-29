import sys
import os
import json
from pathlib import Path

# Python 3.8+ on Windows requires explicit DLL directories for CUDA libs
import site
for _sp in site.getsitepackages():
    for _sub in ['nvidia/cublas/bin', 'nvidia/cudnn/bin', 'nvidia/cuda_nvrtc/bin']:
        _d = os.path.join(_sp, *_sub.split('/'))
        if os.path.isdir(_d):
            os.add_dll_directory(_d)

def transcribe(video_path, output_path, clip_id):
    out = Path(output_path)
    if out.exists():
        data = json.loads(out.read_text(encoding='utf-8'))
        if not data.get('error'):
            print(f"[SKIP] {clip_id} transcript already exists")
            return
        out.unlink()

    out.parent.mkdir(parents=True, exist_ok=True)

    from faster_whisper import WhisperModel

    try:
        model = WhisperModel("large-v3", device="cuda", compute_type="float16")
        segments, info = model.transcribe(video_path, word_timestamps=True, task="translate")
        words = []
        full_text = []
        for seg_idx, seg in enumerate(segments):
            full_text.append(seg.text.strip())
            if seg.words:
                for w in seg.words:
                    words.append({"word": w.word, "start": round(w.start, 3), "end": round(w.end, 3), "seg": seg_idx})

        result = {
            "clip_id": clip_id,
            "language": info.language,
            "duration": info.duration,
            "text": " ".join(full_text),
            "words": words
        }
        print(f"[OK] {clip_id}: {len(words)} words, lang={info.language}")

    except Exception as e:
        result = {"clip_id": clip_id, "error": str(e), "text": "", "words": []}
        print(f"[ERR] {clip_id}: {e}")

    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    transcribe(sys.argv[1], sys.argv[2], sys.argv[3])
