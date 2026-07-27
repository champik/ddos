#!/usr/bin/env node
// DDOS Pipeline — GAMING_SCREEN
// Перевіряє gaming-кліпи на вебку/VTuber/турнірний HUD через 1 кадр на кліп.
// Claude переглядає contact-sheet у розмові (без API-викликів зі скрипта) і пише рішення
// в clips/gaming-screen-results.json, потім запускає --apply.
//
// Usage:
//   node scripts/gaming-screen.js <runId> --prepare   витягує кадри + contact sheet, чекає рішень
//   node scripts/gaming-screen.js <runId> --apply      застосовує рішення, бекфілить якщо треба

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const puppeteer = require('puppeteer');
const { readJson, readJsonSafe, updateState } = require('./lib/state');
const { downloadClip, runParallel } = require('./lib/download');
const { pickByPopularity, selectWithinBroadcastWindow } = require('./lib/select');
const { createTwitchClient, fetchAppAccessToken } = require('./lib/twitch-api');
const { JCIRL_IDS, SPECIALTY_IDS } = require('./lib/categories');
const { getProjectDir } = require('./lib/project-path');
const { getDuration } = require('./lib/media-probe');
require('./lib/env').loadEnv();

const [,, runId, mode] = process.argv;
if (!runId || !['--prepare', '--apply'].includes(mode)) {
  console.error('Usage: node scripts/gaming-screen.js <runId> --prepare|--apply');
  process.exit(1);
}

const RUN_DIR = getProjectDir(runId);
const CLIPS_DIR = path.join(RUN_DIR, 'clips');
const DOWNLOADS_DIR = path.join(RUN_DIR, 'downloads');
const FRAMES_DIR = path.join(CLIPS_DIR, 'gaming-frames');
const RESULTS_PATH = path.join(CLIPS_DIR, 'gaming-screen-results.json');
const SHEET_PATH = path.join(CLIPS_DIR, 'gaming-contact-sheet.png');

const MIN_PASS = 20;   // 20+ пройшло → завершено (норма 20-50)
const MAX_ROUNDS = 2;  // 1 основний раунд + 1 backfill-раунд якщо <20

function isGaming(c) { return !JCIRL_IDS.has(c.game_id) && !SPECIALTY_IDS.has(c.game_id); }

// Скільки ще завантажити. Якщо пройшло <20 і це перший раунд → 2×(потрібно).
// Після другого раунду — завжди done.
function decideNextRound({ passedCount, round }) {
  if (passedCount >= MIN_PASS || round >= MAX_ROUNDS) {
    return { done: true, need: 0 };
  }
  return { done: false, need: (MIN_PASS - passedCount) * 2 };
}

function extractFrame(input, timestamp, output) {
  const r = spawnSync('ffmpeg', [
    '-ss', String(Math.max(0, timestamp)),
    '-i', input,
    '-frames:v', '1',
    '-vf', 'scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2',
    '-q:v', '4',
    '-update', '1',
    '-y', output
  ], { stdio: 'pipe', encoding: 'utf8' });
  return r.status === 0;
}

async function buildContactSheet(entries, outPath) {
  const cellsHtml = entries.map((e, i) => {
    const b64 = fs.readFileSync(e.framePath).toString('base64');
    return `
      <div style="display:flex;flex-direction:column;align-items:center;margin:6px;width:480px">
        <img src="data:image/jpeg;base64,${b64}" width="480" height="270" style="border:2px solid #333" />
        <div style="font-family:monospace;font-size:14px;color:#000;margin-top:4px">${i + 1}. ${e.label}</div>
      </div>`;
  }).join('\n');

  const html = `<!DOCTYPE html><html><body style="margin:0;background:#fff">
    <div style="display:flex;flex-wrap:wrap">${cellsHtml}</div>
  </body></html>`;

  const tmpHtml = outPath.replace('.png', '_tmp.html');
  fs.writeFileSync(tmpHtml, html);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-web-security', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 2000, height: 1200 });
  await page.goto('file://' + path.resolve(tmpHtml), { waitUntil: 'networkidle0', timeout: 15000 });
  await page.screenshot({ path: outPath, type: 'png', fullPage: true });
  await browser.close();
  fs.unlinkSync(tmpHtml);
}

function loadResults() {
  return readJsonSafe(RESULTS_PATH, {});
}

async function prepare() {
  const downloaded = readJson(path.join(CLIPS_DIR, 'downloaded-clips.json'));
  const gaming = downloaded.filter(isGaming);
  const results = loadResults();

  const unscreened = gaming.filter(c => !results[c.id]);
  if (unscreened.length === 0) {
    console.log('[GAMING_SCREEN] Немає нових кліпів для скринінгу. Запусти --apply.');
    return;
  }

  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  const entries = [];
  let autoFailed = 0;
  for (const clip of unscreened) {
    const filePath = path.join(DOWNLOADS_DIR, path.basename(clip.localPath));
    const framePath = path.join(FRAMES_DIR, `${clip.id}.jpg`);
    const duration = getDuration(filePath) || clip.duration || 10;
    const ok = extractFrame(filePath, duration / 2, framePath);
    if (!ok) {
      console.warn(`  [WARN] frame extraction failed, auto-rejecting: ${clip.id} (${clip.broadcaster_name})`);
      results[clip.id] = { pass: false, reason: 'extract_failed' };
      autoFailed++;
      continue;
    }
    entries.push({ clipId: clip.id, framePath, label: `${clip.broadcaster_name} (${clip.id})` });
  }

  if (autoFailed > 0) {
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    console.log(`[GAMING_SCREEN] ${autoFailed} кліп(ів) автоматично відхилено (не вдалось витягти кадр) — піде у backfill через --apply.`);
  }

  if (entries.length === 0) {
    console.log('[GAMING_SCREEN] Усі кліпи цього раунду відхилені автоматично. Запусти --apply.');
    return;
  }

  await buildContactSheet(entries, SHEET_PATH);

  console.log(`[GAMING_SCREEN] Contact sheet готовий: ${SHEET_PATH}`);
  console.log(`[GAMING_SCREEN] ${entries.length} кліпів на перевірку:`);
  entries.forEach((e, i) => console.log(`  ${i + 1}. ${e.clipId} — ${e.label}`));
  console.log('\nПравило pass: ВСІ три умови мають бути true одночасно:');
  console.log('  ✓ є реальна вебка з обличчям людини (не анімація)');
  console.log('  ✓ НЕ VTuber (анімований аватар)');
  console.log('  ✓ НЕМА турнірного HUD (скорборд 5-на-5 команд, турнірна таблиця)');
  console.log('  → якщо є вебка але є турнірний HUD — pass: false, reason: "tournament_hud"');
  console.log(`\nЗапиши рішення в ${RESULTS_PATH} як { "<clipId>": { "pass": true|false, "reason": "no_facecam"|"vtuber"|"tournament_hud"|null } }`);
  console.log('Потім запусти: node scripts/gaming-screen.js ' + runId + ' --apply');

  updateState(RUN_DIR, s => { s.stages.gaming_screen = 'running'; });
}

async function apply() {
  const downloaded = readJson(path.join(CLIPS_DIR, 'downloaded-clips.json'));
  const results = loadResults();
  const gaming = downloaded.filter(isGaming);

  const unscreened = gaming.filter(c => !results[c.id]);
  if (unscreened.length > 0) {
    console.error(`[GAMING_SCREEN] ${unscreened.length} кліпів ще не мають рішення в ${RESULTS_PATH}. Заверши --prepare review спочатку.`);
    process.exit(1);
  }

  const passed = gaming.filter(c => results[c.id]?.pass === true);
  const rejected = gaming.filter(c => results[c.id]?.pass === false);

  for (const c of rejected) {
    const filePath = path.join(DOWNLOADS_DIR, path.basename(c.localPath));
    try { fs.unlinkSync(filePath); } catch {}
    const framePath = path.join(FRAMES_DIR, `${c.id}.jpg`);
    try { fs.unlinkSync(framePath); } catch {}
  }

  const remaining = downloaded.filter(c => !rejected.some(r => r.id === c.id));
  fs.writeFileSync(path.join(CLIPS_DIR, 'downloaded-clips.json'), JSON.stringify(remaining, null, 2));

  console.log(`[GAMING_SCREEN] Пройшло: ${passed.length} (мінімум ${MIN_PASS}), відхилено: ${rejected.length}`);

  const state = readJson(path.join(RUN_DIR, 'state.json'));
  const round = (state.gamingScreenRounds || 0) + 1;

  const decision = decideNextRound({ passedCount: passed.length, round });

  if (decision.done) {
    updateState(RUN_DIR, s => { s.stages.gaming_screen = 'done'; s.gamingScreenRounds = round; });
    console.log(`[GAMING_SCREEN] Готово. ${passed.length} gaming-кліпів пройшли скрин${passed.length < MIN_PASS ? ' (нижче мінімуму — прийнято як є)' : ''}.`);
    return;
  }

  const filtered = readJson(path.join(CLIPS_DIR, 'filtered-clips.json'));
  const gamingPool = filtered.filter(isGaming);

  // results (gaming-screen-results.json) накопичує рішення по ВСІХ коли-небудь
  // проскринених кліпах і ніколи не очищується — на відміну від downloaded-clips.json,
  // звідки відхилені кліпи вже видалені вище. Відновлюємо повні об'єкти кліпів
  // через gamingPool (теж ніколи не урізається), щоб caps (maxPerStreamer/maxPerGame)
  // рахувались коректно і відхилений раніше кліп не зміг повернутись у backfill.
  const everDecidedIds = new Set(Object.keys(results));
  const everAttempted = gamingPool.filter(c => everDecidedIds.has(c.id));

  let backfill = pickByPopularity(gamingPool, {
    limit: decision.need,
    maxPerStreamer: 5,
    maxPerGame: 5,
    alreadySelected: everAttempted,
  });

  // Same broadcast-window check SELECT applies — without it, backfill rounds
  // could reintroduce clips whose real broadcast predates the ingest window
  // (created_at alone doesn't guarantee that; see scripts/lib/select.js).
  if (state.ingestWindowStart) {
    const windowStartMs = new Date(state.ingestWindowStart).getTime();
    const beforeCount = backfill.length;
    const clientId = process.env.TWITCH_CLIENT_ID;
    const token = process.env.TWITCH_TOKEN || await fetchAppAccessToken(clientId, process.env.TWITCH_CLIENT_SECRET);
    const twitch = createTwitchClient(clientId, token);
    backfill = await selectWithinBroadcastWindow(backfill, gamingPool.filter(c => !everAttempted.some(a => a.id === c.id)), windowStartMs, twitch);
    const dropped = beforeCount - backfill.length;
    if (dropped > 0) {
      console.log(`[GAMING_SCREEN] Broadcast-window check: dropped ${dropped} clip(s) whose real broadcast predates the window`);
    }
  } else {
    console.warn('[GAMING_SCREEN] state.ingestWindowStart відсутній (старий run) — broadcast-window перевірка пропущена для backfill.');
  }

  if (backfill.length === 0) {
    updateState(RUN_DIR, s => { s.stages.gaming_screen = 'done'; s.gamingScreenRounds = round; });
    console.log(`[GAMING_SCREEN] Пул кандидатів вичерпано. Приймаємо ${passed.length}.`);
    return;
  }

  console.log(`[GAMING_SCREEN] Пройшло < ${MIN_PASS} — довантажую ще ${backfill.length} (2×потрібно)...`);
  const tasks = backfill.map(clip => () => downloadClip(clip, DOWNLOADS_DIR));
  const dlResults = await runParallel(tasks, 5);
  const newClips = dlResults
    .filter(r => r.status === 'ok' || r.status === 'skipped')
    .map(r => ({ ...r.clip, localPath: path.join(RUN_DIR, 'downloads', r.filename).replace(/\\/g, '/') }));

  const updatedDownloaded = [...remaining, ...newClips];
  fs.writeFileSync(path.join(CLIPS_DIR, 'downloaded-clips.json'), JSON.stringify(updatedDownloaded, null, 2));

  updateState(RUN_DIR, s => { s.gamingScreenRounds = round; });
  console.log(`[GAMING_SCREEN] Завантажено ${newClips.length}. Запусти --prepare знову для перевірки.`);
}

(mode === '--prepare' ? prepare() : apply()).catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
