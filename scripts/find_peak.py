#!/usr/bin/env python3
"""Find the 1-second window with highest average RMS audio energy in a video."""
import subprocess, json, sys, re

def find_peak(path):
    result = subprocess.run(
        ['ffmpeg', '-i', path,
         '-af', 'astats=metadata=1:reset=30,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
         '-f', 'null', '-'],
        capture_output=True, text=True
    )
    values = []
    for line in (result.stdout + result.stderr).split('\n'):
        m = re.search(r'lavfi\.astats\.Overall\.RMS_level=([-\d.inf]+)', line)
        if m:
            try:
                v = float(m.group(1))
                if v > -100:  # filter -inf
                    values.append(v)
            except (ValueError, OverflowError):
                pass

    if not values:
        return {"start": 0.0, "end": 1.0, "rmsDb": -50.0}

    window = min(30, len(values))
    best_i, best_avg = 0, -999.0
    for i in range(max(1, len(values) - window + 1)):
        chunk = values[i:i+window]
        avg = sum(chunk) / len(chunk)
        if avg > best_avg:
            best_avg, best_i = avg, i

    start = round(best_i / 30.0, 2)
    return {"start": start, "end": round(start + 1.0, 2), "rmsDb": round(best_avg, 2)}

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: find_peak.py <video.mp4>"}))
        sys.exit(1)
    print(json.dumps(find_peak(sys.argv[1])))
