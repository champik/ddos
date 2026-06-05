import sys
import os
import json
from pathlib import Path

# Windows: import torch first to let it initialize its own CUDA DLLs,
# then ctranslate2 will find them already loaded
import torch as _torch_init  # noqa: F401 — side effect: loads CUDA DLLs

def transcribe(video_path, output_path, clip_id):
    out = Path(output_path)
    if out.exists():
        data = json.loads(out.read_text(encoding='utf-8'))
        if not data.get('error'):
            print(f"[SKIP] {clip_id} transcript already exists")
            return
        out.unlink()

    out.parent.mkdir(parents=True, exist_ok=True)

    try:
        import whisperx
        import torch

        if torch.cuda.is_available():
            try:
                # Disable cuDNN RNN path — fixes CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH
                # with pyannote VAD LSTM on PyTorch+cu128 / cuDNN 9.x
                torch.backends.cudnn.enabled = False
                device = "cuda"
                compute_type = "float16"
                model = whisperx.load_model("large-v2", device=device, compute_type=compute_type)
                audio = whisperx.load_audio(video_path)
                result = model.transcribe(audio, batch_size=16)
            except Exception as cuda_err:
                print(f"[CUDA FAIL] {cuda_err} — falling back to CPU")
                device = "cpu"
                compute_type = "int8"
                model = whisperx.load_model("small", device=device, compute_type=compute_type)
                audio = whisperx.load_audio(video_path)
                result = model.transcribe(audio, batch_size=8)
        else:
            device = "cpu"
            compute_type = "int8"
            model = whisperx.load_model("small", device=device, compute_type=compute_type)
            audio = whisperx.load_audio(video_path)
            result = model.transcribe(audio, batch_size=8)

        language = result.get("language", "en")

        # Forced alignment for accurate word-level timestamps
        model_a, metadata = whisperx.load_align_model(language_code=language, device=device)
        result = whisperx.align(result["segments"], model_a, metadata, audio, device=device, return_char_alignments=False)

        words = []
        full_text = []
        for seg_idx, seg in enumerate(result["segments"]):
            full_text.append(seg.get("text", "").strip())
            for w in seg.get("words", []):
                if "start" in w and "end" in w:
                    words.append({
                        "word": w["word"],
                        "start": round(w["start"], 3),
                        "end": round(w["end"], 3),
                        "seg": seg_idx
                    })

        duration = round(len(audio) / 16000, 3)
        result_data = {
            "clip_id": clip_id,
            "language": language,
            "duration": duration,
            "text": " ".join(full_text),
            "words": words
        }
        print(f"[OK] {clip_id}: {len(words)} words, lang={language}")

    except Exception as e:
        result_data = {"clip_id": clip_id, "error": str(e), "text": "", "words": []}
        print(f"[ERR] {clip_id}: {e}")

    with open(out, "w", encoding="utf-8") as f:
        json.dump(result_data, f, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    transcribe(sys.argv[1], sys.argv[2], sys.argv[3])
