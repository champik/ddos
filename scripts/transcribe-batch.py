#!/usr/bin/env python
# scripts/transcribe-batch.py — batch transcription with optional demucs vocal separation
# Called by transcribe-batch.js with a path to a JSON jobs file.
# Models load ONCE for all clips — much faster than per-clip spawning.
#
# Usage: python scripts/transcribe-batch.py <jobs.json>
# jobs.json: [{"video_path": "...", "output_path": "...", "clip_id": "..."}, ...]

import sys, json, math, time, traceback, subprocess
from pathlib import Path
import numpy as np

import torch as _torch_init  # noqa — side effect: loads CUDA DLLs before ctranslate2
import torch
torch.backends.cudnn.enabled = False  # fix CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH


# ── helpers ─────────────────────────────────────────────────────────────────

def rms_in_window(audio_arr, start_s, end_s, sr=16000):
    s = max(0, int(start_s * sr))
    e = min(len(audio_arr), int(end_s * sr))
    if e <= s:
        return 0.0
    chunk = audio_arr[s:e].astype(np.float32)
    return float(np.sqrt(np.mean(chunk ** 2)))


def find_speech_region(audio_arr, target_dur_s, sr=16000, step=0.1):
    total_s = len(audio_arr) / sr
    best_start, best_rms = 0.0, 0.0
    t = 0.0
    while t + target_dur_s <= total_s:
        r = rms_in_window(audio_arr, t, t + target_dur_s)
        if r > best_rms:
            best_rms, best_start = r, t
        t += step
    return best_start


def extract_words(result, seg_anchors, audio, duration):
    words = []
    full_text = []
    for seg_idx, seg in enumerate(result['segments']):
        full_text.append(seg.get('text', '').strip())
        seg_words = [w for w in seg.get('words', []) if 'start' in w and 'end' in w]
        if not seg_words:
            continue

        anchor       = seg_anchors[seg_idx] if seg_idx < len(seg_anchors) else None
        anchor_start = anchor['start'] if anchor else seg_words[0]['start']
        anchor_end   = anchor['end']   if anchor else seg_words[-1]['end']
        anchor_dur   = max(anchor_end - anchor_start, 0.5)

        word_min  = seg_words[0]['start']
        word_max  = seg_words[-1]['end']
        MARGIN    = 1.5

        misaligned = (word_min < anchor_start - MARGIN or
                      word_max > anchor_end   + MARGIN or
                      word_min > anchor_end   + MARGIN)

        if misaligned:
            real_start = find_speech_region(audio, anchor_dur)
            real_end   = real_start + anchor_dur
            print(f'  [ALIGN-FIX] seg {seg_idx}: {word_min:.2f}-{word_max:.2f} -> {real_start:.2f}-{real_end:.2f}', flush=True)
            n = len(seg_words)
            for i, w in enumerate(seg_words):
                t_s = real_start + (i / n) * anchor_dur
                t_e = real_start + ((i + 1) / n) * anchor_dur
                words.append({'word': w['word'], 'start': round(t_s, 3), 'end': round(t_e, 3), 'seg': seg_idx, 'retimed': True})
            continue

        for w in seg_words:
            entry = {'word': w['word'], 'start': round(w['start'], 3), 'end': round(w['end'], 3), 'seg': seg_idx}
            if w.get('score') is None:
                entry['interp'] = True  # wav2vec2 не вирівняв — таймінг інтерпольований
            words.append(entry)

    return words, ' '.join(full_text)


def fix_cram_runs(words, audio, duration, sr=16000):
    """WhisperX інтерполює слова, які не вдалось вирівняти (типово — після довгої
    паузи всередині сегмента): вони отримують нульові гепи та однакові короткі
    тривалості одразу після попереднього слова, ігноруючи паузу. Знаходимо такі
    серії (без alignment score або з підозрілим таймінгом) і перерозподіляємо
    їх по реальному мовленню (RMS) між сусідніми надійними якорями."""
    def suspicious(k):
        w = words[k]
        if w.get('retimed'):
            return False  # вже перерозподілено ALIGN-FIX-ом
        if w.get('interp'):
            return True
        dur = w['end'] - w['start']
        gap = (w['start'] - words[k - 1]['end']) if k > 0 else 1.0
        return dur < 0.15 and 0 <= gap < 0.03

    i, fixed = 0, 0
    while i < len(words):
        if not suspicious(i):
            i += 1
            continue
        j = i
        while j + 1 < len(words) and suspicious(j + 1) and words[j + 1].get('seg') == words[i].get('seg'):
            j += 1
        n = j - i + 1
        if n < 3:  # 1-2 підозрілих слова між нормальними — інтерполяція ок
            i = j + 1
            continue

        t0 = words[i - 1]['end'] if i > 0 else max(0.0, words[i]['start'])
        t1 = words[j + 1]['start'] if j + 1 < len(words) else duration
        if t1 - t0 < 0.3:
            i = j + 1
            continue

        # Чисто таймінговий патерн без interp-мітки буває і в легітимному швидкому
        # мовленні — перерозподіляємо лише коли за серією є "проковтнута" пауза
        # (великий геп до наступного якоря — сигнатура WhisperX-інтерполяції).
        has_interp = any(words[k].get('interp') for k in range(i, j + 1))
        if not has_interp and (t1 - words[j]['end']) < 0.8:
            i = j + 1
            continue

        speech_dur = min(max(0.22 * n, 0.5), t1 - t0)
        seg_audio = audio[int(t0 * sr):int(t1 * sr)]
        off = find_speech_region(seg_audio, speech_dur) if len(seg_audio) > sr // 5 else 0.0
        real_start = t0 + off
        print(f'  [CRAM-FIX] {n} words {words[i]["start"]:.2f}-{words[j]["end"]:.2f} -> {real_start:.2f}-{real_start + speech_dur:.2f}', flush=True)
        for k in range(n):
            w = words[i + k]
            w['start'] = round(real_start + (k / n) * speech_dur, 3)
            w['end']   = round(real_start + ((k + 1) / n) * speech_dur, 3)
            w['retimed'] = True
        fixed += 1
        i = j + 1
    return words


def rms_profile(audio_arr, sr=16000, win=0.25):
    """Профіль гучності (dB) вікнами win секунд — для gen-captions.js.
    Рахується по transcribe_audio: після demucs це ЧИСТИЙ ВОКАЛ, тобто
    детект крику не тригериться на гучний геймплей/музику у міксі."""
    step = int(win * sr)
    out = []
    for s in range(0, len(audio_arr), step):
        chunk = audio_arr[s:s + step].astype(np.float32)
        if len(chunk) == 0:
            break
        r = float(np.sqrt(np.mean(chunk ** 2)))
        db = 20 * math.log10(r) if r > 1e-9 else -120.0
        out.append([round(s / sr, 2), round(db, 1)])
    return out


# ── demucs ───────────────────────────────────────────────────────────────────

def _ffmpeg_load_stereo(path, target_sr):
    """Decode audio to stereo float32 numpy [2, samples] via ffmpeg subprocess."""
    cmd = ['ffmpeg', '-nostdin', '-threads', '0', '-i', str(path),
           '-f', 'f32le', '-ac', '2', '-ar', str(target_sr), '-']
    out = subprocess.run(cmd, capture_output=True)
    arr = np.frombuffer(out.stdout, dtype=np.float32).copy().reshape(-1, 2).T
    return arr  # [2, samples]


def load_demucs(device):
    try:
        from demucs.pretrained import get_model
        from demucs.apply import apply_model as _apply
        model = get_model('htdemucs')
        model.eval()
        if device == 'cuda':
            model = model.cuda()
        print(f'[DEMUCS] Loaded htdemucs on {device} (sr={model.samplerate})', flush=True)
        return model
    except ImportError:
        print('[DEMUCS] Not installed — using raw audio', flush=True)
        return None
    except Exception as e:
        print(f'[DEMUCS] Load failed ({e}) — using raw audio', flush=True)
        return None


def extract_vocals(demucs_model, video_path, target_sr=16000):
    from demucs.apply import apply_model
    import torchaudio.functional as F_audio

    wav_np = _ffmpeg_load_stereo(video_path, demucs_model.samplerate)
    wav = torch.from_numpy(wav_np).unsqueeze(0)  # [1, 2, samples]
    if next(demucs_model.parameters()).is_cuda:
        wav = wav.cuda()

    with torch.no_grad():
        sources = apply_model(demucs_model, wav)  # [1, stems, 2, samples]

    vocals_idx = demucs_model.sources.index('vocals')
    vocals_mono = sources[0, vocals_idx].mean(dim=0)  # [samples] at model.samplerate

    if demucs_model.samplerate != target_sr:
        vocals_mono = F_audio.resample(
            vocals_mono.unsqueeze(0),
            orig_freq=demucs_model.samplerate,
            new_freq=target_sr,
        ).squeeze(0)

    return vocals_mono.cpu().numpy().astype(np.float32)


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    jobs_file = sys.argv[1]
    jobs = json.loads(Path(jobs_file).read_text(encoding='utf-8'))

    if not jobs:
        print('[OK] No clips to transcribe', flush=True)
        return

    device       = 'cuda' if torch.cuda.is_available() else 'cpu'
    compute_type = 'float16' if device == 'cuda' else 'int8'
    print(f'[INIT] device={device}, {len(jobs)} clips', flush=True)

    separator = load_demucs(device)

    import whisperx
    model_name = 'large-v3' if device == 'cuda' else 'small'
    print(f'[WHISPERX] Loading {model_name}...', flush=True)
    model = whisperx.load_model(model_name, device=device, compute_type=compute_type,
        asr_options={
            'condition_on_previous_text': False,
            'repetition_penalty': 1.3,
            'beam_size': 8,
            'compression_ratio_threshold': 1.8,
        })
    print('[WHISPERX] Ready', flush=True)

    align_cache = {}
    def get_align_model(lang):
        if lang not in align_cache:
            align_cache[lang] = whisperx.load_align_model(language_code=lang, device=device)
        return align_cache[lang]

    elapsed_list = []

    for i, job in enumerate(jobs):
        video_path  = job['video_path']
        output_path = job['output_path']
        clip_id     = job['clip_id']
        skip_demucs = job.get('skip_demucs', False)
        out         = Path(output_path)
        prefix      = f'[{i + 1}/{len(jobs)}]'

        if out.exists():
            try:
                data = json.loads(out.read_text(encoding='utf-8'))
                if not data.get('error'):
                    print(f'{prefix} SKIP {clip_id}', flush=True)
                    continue
                out.unlink()
            except Exception:
                pass

        out.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        d_elapsed = 0.0

        try:
            raw_audio = whisperx.load_audio(video_path)
            duration  = round(len(raw_audio) / 16000, 3)

            if separator is not None and not skip_demucs:
                t_d = time.time()
                vocals = extract_vocals(separator, video_path)
                d_elapsed = time.time() - t_d
                # Sanity check: if vocals are near-silent, fall back to raw
                if rms_in_window(vocals, 0, duration) < 1e-4:
                    print(f'  [DEMUCS] vocals silent — using raw audio', flush=True)
                    transcribe_audio = raw_audio
                    d_elapsed = 0.0
                else:
                    transcribe_audio = vocals
            else:
                if skip_demucs:
                    print(f'  [DEMUCS] skipped (skip_demucs=true)', flush=True)
                transcribe_audio = raw_audio

            result   = model.transcribe(transcribe_audio, batch_size=16)
            language = result.get('language', 'en')

            if language != 'en':
                print(f'  [TRANSLATE] detected lang={language}', flush=True)
                result = model.transcribe(transcribe_audio, batch_size=16, task='translate')

            align_lang    = 'en' if language != 'en' else language
            model_a, meta = get_align_model(align_lang)

            seg_anchors = [{'start': s.get('start', 0.0), 'end': s.get('end', 0.0)}
                           for s in result['segments']]

            result = whisperx.align(result['segments'], model_a, meta, transcribe_audio,
                                    device=device, return_char_alignments=False)

            words, text = extract_words(result, seg_anchors, transcribe_audio, duration)
            words = fix_cram_runs(words, transcribe_audio, duration)

            total = time.time() - t0
            elapsed_list.append(total)
            demucs_info = f', demucs={d_elapsed:.1f}s' if d_elapsed else ''
            print(f'{prefix} OK {clip_id}: {len(words)} words, lang={align_lang}{demucs_info}, total={total:.1f}s', flush=True)

            remaining = len(jobs) - (i + 1)
            if remaining > 0 and elapsed_list:
                avg = sum(elapsed_list) / len(elapsed_list)
                print(f'  avg {avg:.1f}s/clip, {remaining} left ~{avg * remaining / 60:.1f} min', flush=True)

            result_data = {
                'clip_id':  clip_id,
                'language': align_lang,
                'duration': duration,
                'text':     text,
                'words':    words,
                # Профіль гучності для КАПС-детекту в gen-captions.js:
                # 'vocals' = після demucs (чистий голос), 'mix' = повний мікс
                'vocals_rms': rms_profile(transcribe_audio),
                'vocals_rms_source': 'vocals' if (separator is not None and not skip_demucs and transcribe_audio is not raw_audio) else 'mix',
            }

        except Exception as e:
            print(f'{prefix} ERR {clip_id}: {e}', flush=True)
            traceback.print_exc(file=sys.stdout)
            result_data = {'clip_id': clip_id, 'error': str(e), 'text': '', 'words': []}

        with open(out, 'w', encoding='utf-8') as f:
            json.dump(result_data, f, ensure_ascii=False, indent=2)

    total_clips = len([j for j in jobs])
    print(f'[DONE] {len(elapsed_list)} transcribed, {total_clips - len(elapsed_list)} skipped/failed', flush=True)


if __name__ == '__main__':
    main()
