#!/usr/bin/env node
/**
 * Run transcription for all downloaded clips using faster-whisper
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node run-transcribe.js <runId>'); process.exit(1); }

// Add nvidia CUDA DLL directories to PATH so faster-whisper can find cublas64_12.dll etc.
const pythonSitePackages = spawnSync('python', ['-c', 'import site; print(site.getsitepackages()[0])'], { encoding: 'utf8' }).stdout.trim();
const nvidiaBinDirs = ['nvidia/cublas/bin', 'nvidia/cudnn/bin', 'nvidia/cuda_nvrtc/bin']
  .map(p => path.join(pythonSitePackages, ...p.split('/')))
  .filter(p => fs.existsSync(p));
if (nvidiaBinDirs.length > 0) {
  process.env.PATH = nvidiaBinDirs.join(path.delimiter) + path.delimiter + process.env.PATH;
}

const projectDir = path.join('projects', runId);
const clipsDir = path.join(projectDir, 'clips');
const processedDir = path.join(projectDir, 'processed');

function updateState(updates) {
  const statePath = path.join(projectDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const [key, val] of Object.entries(updates)) {
    const parts = key.split('.');
    let obj = state;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = val;
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

async function main() {
  const clips = JSON.parse(fs.readFileSync(path.join(clipsDir, 'downloaded-clips.json'), 'utf8'));
  console.log(`Transcribing ${clips.length} clips...`);
  updateState({ 'stages.transcribe': 'running' });

  let done = 0, skipped = 0, errors = 0;

  for (const clip of clips) {
    const clipId = clip.id;
    const clipProcessedDir = path.join(processedDir, clipId);
    fs.mkdirSync(clipProcessedDir, { recursive: true });

    const transcriptPath = path.join(clipProcessedDir, 'transcript.json');
    if (fs.existsSync(transcriptPath)) {
      skipped++;
      done++;
      continue;
    }

    const videoPath = clip.localPath;
    if (!fs.existsSync(videoPath)) {
      console.error(`  WARN: video not found: ${videoPath}`);
      errors++;
      done++;
      continue;
    }

    process.stdout.write(`  [${done + 1}/${clips.length}] ${clip.broadcaster_name} (${clip.game_name})... `);
    const result = spawnSync('python', [
      'scripts/transcribe.py',
      videoPath,
      transcriptPath,
      clipId
    ], { stdio: 'pipe', encoding: 'utf8', timeout: 300000 });

    // Check output file — ctranslate2 sometimes crashes during CUDA cleanup (exit 9)
    // but the transcript is already written before the crash
    const fileOk = fs.existsSync(transcriptPath) && (() => {
      try { const d = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')); return !d.error; } catch { return false; }
    })();

    if (fileOk) {
      const out = (result.stdout || '').trim();
      console.log(out.split('\n').pop() || 'OK');
    } else {
      const err = (result.stderr || result.stdout || '').trim().slice(0, 200);
      console.log(`FAIL: ${err}`);
      fs.writeFileSync(transcriptPath, JSON.stringify({ clip_id: clipId, error: 'transcribe failed', text: '', words: [] }));
      errors++;
    }
    done++;
  }

  updateState({ 'stages.transcribe': 'done' });
  console.log(`\nTranscription: ${done - errors - skipped} new, ${skipped} cached, ${errors} errors`);
}

main().catch(e => {
  console.error('TRANSCRIBE ERROR:', e.message);
  updateState({ 'stages.transcribe': 'failed' });
  process.exit(1);
});
