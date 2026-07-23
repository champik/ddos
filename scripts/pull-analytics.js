#!/usr/bin/env node
'use strict';
// pull-analytics.js — фідбек-луп: тягне метрики каналу з YouTube Data API +
// YouTube Analytics API v2 і складає все в analytics/.
//
// Usage: node scripts/pull-analytics.js [--days 28] [--retention-days 7] [--no-report]
//
// Що тягне:
//   1. Всі відео каналу, опубліковані за останні --days днів (uploads playlist
//      + analytics/videos-index.json ledger для мапінгу на runId/clipId/стрімерів)
//   2. Per-video метрики за вікно: views, watch time, AVD, avgViewPercentage,
//      likes, comments, shares, subscribersGained
//   3. Ретеншн-криві (audienceWatchRatio по elapsedVideoTimeRatio) — для епізодів
//      останніх --retention-days днів (макс 10)
//   4. Traffic sources по каналу за вікно
//
// ВАЖЛИВО: thumbnail impressions/CTR НЕ доступні через публічний API (тільки Studio).
//   Опційно: analytics/manual-ctr.json = { "<videoId>": { "impressions": N, "ctr": 5.2 } }
//   — заповнюється руками зі Studio, підхоплюється сюди і показується у звіті.
//
// Результат:
//   analytics/data/snapshot-YYYY-MM-DD.json  — сирий знімок дня
//   analytics/performance.json               — зведені дані для звіту
//   analytics/index.html                     — звіт (build-analytics-report.js)
//
// Дані Analytics API мають лаг ~48 год — свіжі відео перші 2 дні показують нулі,
// це нормально; звіт враховує вік відео.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { google } = require('googleapis');
const { getAuth } = require('./lib/yt-auth');
const { writeJsonAtomic, readJsonSafe } = require('./lib/state');
const { readIndex, ANALYTICS_DIR } = require('./lib/analytics-ledger');

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : def;
}
const DAYS = parseInt(argVal('--days', '28'), 10);
const RETENTION_DAYS = parseInt(argVal('--retention-days', '7'), 10);
const MAX_RETENTION_VIDEOS = 10;
const NO_REPORT = process.argv.includes('--no-report');

const DATA_DIR = path.join(ANALYTICS_DIR, 'data');

function isoDate(d) { return d.toISOString().slice(0, 10); }

// ISO8601 duration (PT1M23S) → секунди
function parseDuration(iso) {
  const m = (iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseFloat(m[3] || 0);
}

async function listUploadsSince(yt, cutoffISO) {
  const ch = await yt.channels.list({ part: ['contentDetails'], mine: true });
  const uploadsId = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) throw new Error('Uploads playlist не знайдено — канал порожній або немає доступу');

  const ids = [];
  let pageToken = null;
  for (let page = 0; page < 20; page++) { // safety cap: 20×50 = 1000 відео
    const res = await yt.playlistItems.list({
      part: ['contentDetails'], playlistId: uploadsId, maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    let reachedCutoff = false;
    for (const item of (res.data.items || [])) {
      const publishedAt = item.contentDetails?.videoPublishedAt;
      // Заплановані (ще не опубліковані) відео не мають videoPublishedAt — пропускаємо
      if (!publishedAt) continue;
      if (publishedAt < cutoffISO) { reachedCutoff = true; break; }
      ids.push(item.contentDetails.videoId);
    }
    pageToken = res.data.nextPageToken;
    if (reachedCutoff || !pageToken) break;
  }
  return ids;
}

async function fetchVideoDetails(yt, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await yt.videos.list({
      part: ['snippet', 'contentDetails', 'statistics'], id: batch, maxResults: 50,
    });
    for (const v of (res.data.items || [])) {
      out[v.id] = {
        title: v.snippet?.title || '',
        publishedAt: v.snippet?.publishedAt || '',
        durationSec: parseDuration(v.contentDetails?.duration),
        stats: {
          viewsTotal: parseInt(v.statistics?.viewCount || 0),
          likesTotal: parseInt(v.statistics?.likeCount || 0),
          commentsTotal: parseInt(v.statistics?.commentCount || 0),
        },
      };
    }
  }
  return out;
}

async function fetchWindowMetrics(ytAnalytics, ids, startDate, endDate) {
  const metrics = 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained';
  const cols = metrics.split(',');
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await ytAnalytics.reports.query({
      ids: 'channel==MINE', startDate, endDate,
      metrics, dimensions: 'video',
      filters: `video==${batch.join(',')}`,
      maxResults: 50, sort: '-views',
    });
    for (const row of (res.data.rows || [])) {
      const rec = {};
      cols.forEach((c, j) => { rec[c] = row[j + 1]; });
      out[row[0]] = rec;
    }
  }
  return out;
}

async function fetchRetentionCurve(ytAnalytics, videoId, startDate, endDate) {
  const res = await ytAnalytics.reports.query({
    ids: 'channel==MINE', startDate, endDate,
    metrics: 'audienceWatchRatio,relativeRetentionPerformance',
    dimensions: 'elapsedVideoTimeRatio',
    filters: `video==${videoId}`,
  });
  // rows: [ratio 0..1, watchRatio, relPerf]
  return (res.data.rows || []).map(r => ({
    ratio: parseFloat(r[0]),
    watchRatio: parseFloat(r[1]),
    relPerf: r[2] != null ? parseFloat(r[2]) : null,
  }));
}

async function fetchTrafficSources(ytAnalytics, startDate, endDate) {
  const res = await ytAnalytics.reports.query({
    ids: 'channel==MINE', startDate, endDate,
    metrics: 'views,estimatedMinutesWatched',
    dimensions: 'insightTrafficSourceType',
    sort: '-views',
  });
  return (res.data.rows || []).map(r => ({
    source: r[0], views: r[1], minutesWatched: r[2],
  }));
}

async function main() {
  const now = new Date();
  const endDate = isoDate(now);
  const startDate = isoDate(new Date(now.getTime() - DAYS * 86400e3));
  const cutoffISO = startDate + 'T00:00:00Z';

  console.log(`[ANALYTICS] Вікно: ${startDate} → ${endDate} (${DAYS} днів; лаг даних ~48 год)`);

  const auth = await getAuth();
  const yt = google.youtube({ version: 'v3', auth });
  const ytAnalytics = google.youtubeAnalytics({ version: 'v2', auth });

  // 1. Список відео: канал + ledger
  console.log('[ANALYTICS] Читаю список публікацій каналу...');
  const uploadIds = await listUploadsSince(yt, cutoffISO);
  const ledgerEntries = readIndex();
  const ledgerById = Object.fromEntries(ledgerEntries.map(e => [e.videoId, e]));
  const allIds = [...new Set([
    ...uploadIds,
    ...ledgerEntries.filter(e => (e.uploadedAt || '') >= cutoffISO).map(e => e.videoId),
  ])];
  console.log(`[ANALYTICS] Відео у вікні: ${allIds.length} (${uploadIds.length} з каналу, ${allIds.length - uploadIds.length} додатково з ledger)`);

  if (allIds.length === 0) {
    console.log('[ANALYTICS] Немає відео у вікні — нічого збирати.');
    return;
  }

  // 2. Деталі + статистика
  const details = await fetchVideoDetails(yt, allIds);

  // 3. Analytics-метрики за вікно
  console.log('[ANALYTICS] Тягну метрики Analytics API...');
  let windowMetrics;
  try {
    windowMetrics = await fetchWindowMetrics(ytAnalytics, Object.keys(details), startDate, endDate);
  } catch (e) {
    const reason = e.errors?.[0]?.reason || e.response?.data?.error?.errors?.[0]?.reason;
    if (reason === 'accessNotConfigured' || /SERVICE_DISABLED/.test(JSON.stringify(e.response?.data || ''))) {
      const url = e.response?.data?.error?.details?.find(d => d.metadata?.activationUrl)?.metadata?.activationUrl
        || 'https://console.developers.google.com/apis/library/youtubeanalytics.googleapis.com';
      throw new Error(
        `YouTube Analytics API не увімкнений у Google Cloud проєкті.\n` +
        `Відкрий ${url}, натисни "Enable" і повтори запуск (може знадобитись кілька хвилин на розповсюдження).`);
    }
    if ((String(e.message).includes('403') || e.code === 403) && !reason) {
      throw new Error(
        'Analytics API 403 — токен виданий без scope yt-analytics.readonly.\n' +
        'Видали auth/token.json і запусти скрипт ще раз, щоб пройти авторизацію з новим scope.');
    }
    throw e;
  }

  // 4. Класифікація + збірка записів
  const manualCtr = readJsonSafe(path.join(ANALYTICS_DIR, 'manual-ctr.json'), {});
  const videos = Object.entries(details).map(([videoId, d]) => {
    const led = ledgerById[videoId] || {};
    const type = led.type || (d.durationSec > 0 && d.durationSec <= 183 ? 'short' : 'episode');
    return {
      videoId, type,
      runId: led.runId || null,
      clipId: led.clipId || null,
      streamer: led.streamer || null,
      game: led.game || null,
      streamers: led.streamers || null,
      title: d.title,
      publishedAt: d.publishedAt,
      durationSec: d.durationSec,
      totals: d.stats,
      window: windowMetrics[videoId] || null,
      ctr: manualCtr[videoId] || null,
      retention: null,
    };
  }).sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));

  // 5. Ретеншн-криві для свіжих епізодів
  const retentionCutoff = isoDate(new Date(now.getTime() - RETENTION_DAYS * 86400e3));
  const retentionTargets = videos
    .filter(v => v.type === 'episode' && v.publishedAt >= retentionCutoff)
    .slice(0, MAX_RETENTION_VIDEOS);
  console.log(`[ANALYTICS] Ретеншн-криві: ${retentionTargets.length} епізод(ів) за останні ${RETENTION_DAYS} днів`);
  for (const v of retentionTargets) {
    try {
      v.retention = await fetchRetentionCurve(ytAnalytics, v.videoId, startDate, endDate);
    } catch (e) {
      console.warn(`  [WARN] retention ${v.videoId}: ${e.message}`);
    }
  }

  // 6. Traffic sources по каналу
  let trafficSources = [];
  try {
    trafficSources = await fetchTrafficSources(ytAnalytics, startDate, endDate);
  } catch (e) {
    console.warn(`  [WARN] traffic sources: ${e.message}`);
  }

  // 7. Записати знімок + performance.json
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const snapshot = { pulledAt: now.toISOString(), startDate, endDate, windowDays: DAYS, videos, trafficSources };
  writeJsonAtomic(path.join(DATA_DIR, `snapshot-${endDate}.json`), snapshot);
  writeJsonAtomic(path.join(ANALYTICS_DIR, 'performance.json'), snapshot);

  const nEp = videos.filter(v => v.type === 'episode').length;
  const nSh = videos.filter(v => v.type === 'short').length;
  console.log(`[ANALYTICS] Збережено: ${nEp} епізодів + ${nSh} шортсів → analytics/performance.json`);

  // 8. Звіт
  if (!NO_REPORT) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'build-analytics-report.js')], { stdio: 'inherit' });
    if (r.status !== 0) console.warn('[ANALYTICS] Звіт не згенеровано (build-analytics-report.js failed)');
  }
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
