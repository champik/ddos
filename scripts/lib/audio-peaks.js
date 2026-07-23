'use strict';
// audio-peaks.js — аналіз гучності (RMS) аудіодоріжки через ffmpeg astats.
// Вікна ~0.25s. Якщо ffmpeg недоступний або аналіз падає — повертає null,
// і споживачі тихо деградують до поведінки без акцентів/панчів.

const { spawnSync } = require('child_process');

const WINDOW_SAMPLES = 12000; // 0.25s при 48kHz
const WINDOW_SEC = 0.25;

// → [{ t, rms }] де t — початок вікна (сек), rms — рівень у dB (відʼємний), або null
// ss/dur: опційний trim для аналізу сегменту source файлу (до loudnorm)
function analyzeRms(filePath, { ss = null, dur = null } = {}) {
  const args = [];
  if (ss != null) args.push('-ss', String(ss));
  args.push('-i', filePath, '-vn');
  if (dur != null) args.push('-t', String(dur));
  args.push(
    '-af', `asetnsamples=n=${WINDOW_SAMPLES},astats=metadata=1:reset=1,` +
           'ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f', 'null', '-',
  );
  const r = spawnSync('ffmpeg', args, { stdio: 'pipe', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0 || !r.stdout) return null;

  const windows = [];
  let t = null;
  for (const line of r.stdout.split('\n')) {
    const pts = line.match(/pts_time:([\d.]+)/);
    if (pts) { t = parseFloat(pts[1]); continue; }
    const rms = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf)/);
    if (rms && t != null) {
      const v = rms[1] === '-inf' ? -120 : parseFloat(rms[1]);
      windows.push({ t, rms: v });
      t = null;
    }
  }
  return windows.length >= 4 ? windows : null;
}

function median(windows) {
  const sorted = windows.map(w => w.rms).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Найгучніший момент (центр вікна), ігноруючи краї кліпу.
// Якщо пік не виділяється над медіаною хоча б на 4 dB (рівне аудіо) — null.
function findPeak(windows, { skipStart = 1.0, skipEnd = 1.5, minProminence = 4 } = {}) {
  if (!windows || windows.length === 0) return null;
  const end = windows[windows.length - 1].t + WINDOW_SEC;
  const usable = windows.filter(w => w.t >= skipStart && w.t + WINDOW_SEC <= end - skipEnd);
  if (usable.length === 0) return null;
  const peak = usable.reduce((a, b) => (b.rms > a.rms ? b : a));
  if (peak.rms - median(windows) < minProminence) return null;
  return { t: peak.t + WINDOW_SEC / 2, rms: peak.rms };
}

// Вікна з голосом: у vocals-профілі (demucs) тиша ~-120dB, і якщо мовлення
// займає < половини кліпу, медіана всіх вікон з'їжджає в тишу — "медіана+8"
// перестає бути порогом крику. Базлайн рахуємо тільки по вікнах у межах
// dropDb від максимуму (де реально звучить голос).
function voicedOnly(windows, dropDb = 35) {
  const max = Math.max(...windows.map(w => w.rms));
  return windows.filter(w => w.rms > max - dropDb);
}

// Поріг "гучного" слова (крику): медіана ГОЛОСНИХ вікон + offsetDb.
// Якщо range (max − медіана) < minRange dB — динаміки в мовленні немає
// (рівна розмова / сильно стиснений кліп), криків не буває → null.
// Це свідомо строгіше за стару версію (range ≥ 2, offset 6): звичайна
// гучна розмова не має тригерити КАПС.
function loudThreshold(windows, offsetDb = 8, minRange = 8) {
  if (!windows || windows.length === 0) return null;
  const voiced = voicedOnly(windows);
  if (voiced.length < 4) return null;
  const med = median(voiced);
  const max = Math.max(...voiced.map(w => w.rms));
  const range = max - med;
  if (range < minRange) return null;
  return med + Math.min(offsetDb, range * 0.85);
}

// Чи припадає момент t на гучне вікно
function isLoudAt(windows, threshold, t) {
  if (!windows || threshold == null) return false;
  const w = windows.find(x => t >= x.t && t < x.t + WINDOW_SEC);
  return !!w && w.rms >= threshold;
}

// Локальна виразність: вікно в момент t має бути на minDeltaDb гучніше за
// СЕРЕДНЄ сусідніх ГОЛОСНИХ вікон у радіусі radiusSec. Відсікає "рівномірно
// гучні" ділянки (музика, галас, просто голосна розмова) — крик є сплеском
// відносно сусіднього МОВЛЕННЯ. Порівняння з тишею не рахується: слово одразу
// після паузи не стає "криком" лише через контраст із тишею — якщо голосних
// сусідів немає, рішення повністю за порогом isLoudAt.
function isProminentAt(windows, t, { radiusSec = 1.0, minDeltaDb = 3 } = {}) {
  if (!windows || windows.length === 0) return false;
  const w = windows.find(x => t >= x.t && t < x.t + WINDOW_SEC);
  if (!w) return false;
  const neighbors = voicedOnly(windows).filter(x => x !== w && Math.abs(x.t - w.t) <= radiusSec);
  if (neighbors.length === 0) return true;
  const meanNb = neighbors.reduce((s, x) => s + x.rms, 0) / neighbors.length;
  return w.rms - meanNb >= minDeltaDb;
}

module.exports = { analyzeRms, findPeak, loudThreshold, isLoudAt, isProminentAt, WINDOW_SEC };
