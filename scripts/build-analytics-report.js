#!/usr/bin/env node
'use strict';
// build-analytics-report.js — analytics/index.html з analytics/performance.json:
// KPI, тренд, таблиці епізодів/шортсів, розбивка по стрімерах, рекомендації.
// Правила рекомендацій — прості й прозорі пороги (див. analytics/README.md).
//
// Usage: node scripts/build-analytics-report.js

const fs = require('fs');
const path = require('path');
const { readJsonSafe } = require('./lib/state');
const { ANALYTICS_DIR } = require('./lib/analytics-ledger');

const perf = readJsonSafe(path.join(ANALYTICS_DIR, 'performance.json'), null);
if (!perf) { console.error('analytics/performance.json не знайдено — спочатку: node scripts/pull-analytics.js'); process.exit(1); }

// ── Пороги (цілі з ddos-youtube-creatives) ──────────────────────────────────
const T = {
  epViewPctGood: 50, epViewPctWarn: 40,     // avgViewPercentage лонгформу
  shViewPctGood: 90, shViewPctWarn: 70,     // avgViewPercentage шортсів
  subsConvGood: 1.0,                        // subscribersGained / views, %
  ctrGood: 8, ctrWarn: 4,                   // manual CTR
  streamerBoost: 1.5, streamerAvoid: 0.5,   // множник відносно медіани шортсів
  minShortsPerStreamer: 2,
  minAgeDays: 3,                            // молодші відео не оцінюємо (лаг даних)
};

const now = Date.now();
const ageDays = v => (now - new Date(v.publishedAt).getTime()) / 86400e3;
const episodes = perf.videos.filter(v => v.type === 'episode');
const shorts = perf.videos.filter(v => v.type === 'short');
const maturedEp = episodes.filter(v => ageDays(v) >= T.minAgeDays && v.window);
const maturedSh = shorts.filter(v => ageDays(v) >= T.minAgeDays && v.window);

const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const avg = (arr, f) => arr.length ? sum(arr, f) / arr.length : 0;
const median = arr => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const fmtN = n => n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : String(Math.round(n || 0));
const fmtPct = n => n == null ? '—' : n.toFixed(1) + '%';
const fmtMMSS = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── KPI ─────────────────────────────────────────────────────────────────────
const kpi = {
  epCount: episodes.length,
  shCount: shorts.length,
  epViews: sum(episodes, v => v.window?.views),
  shViews: sum(shorts, v => v.window?.views),
  epViewPct: avg(maturedEp, v => v.window?.averageViewPercentage),
  epAvd: avg(maturedEp, v => v.window?.averageViewDuration),
  shViewPct: avg(maturedSh, v => v.window?.averageViewPercentage),
  subsGained: sum(perf.videos, v => v.window?.subscribersGained),
};

// ── Тренд: епізоди останніх 7 днів vs попередні ─────────────────────────────
const last7Ep = maturedEp.filter(v => ageDays(v) <= 7 + T.minAgeDays);
const prevEp = maturedEp.filter(v => ageDays(v) > 7 + T.minAgeDays);
const trend = {
  viewsNow: avg(last7Ep, v => v.window?.views),
  viewsPrev: avg(prevEp, v => v.window?.views),
  pctNow: avg(last7Ep, v => v.window?.averageViewPercentage),
  pctPrev: avg(prevEp, v => v.window?.averageViewPercentage),
};
const trendArrow = (a, b) => b <= 0 ? '' : (a >= b * 1.1 ? ' ▲' : a <= b * 0.9 ? ' ▼' : ' ≈');

// ── Стрімери (шортси) ───────────────────────────────────────────────────────
const byStreamer = {};
for (const v of maturedSh) {
  if (!v.streamer) continue;
  (byStreamer[v.streamer] = byStreamer[v.streamer] || []).push(v);
}
const shMedianViews = median(maturedSh.map(v => v.window?.views || 0));
const streamerRows = Object.entries(byStreamer)
  .filter(([, vids]) => vids.length >= T.minShortsPerStreamer)
  .map(([streamer, vids]) => {
    const avgViews = avg(vids, v => v.window?.views);
    const avgPct = avg(vids, v => v.window?.averageViewPercentage);
    const ratio = shMedianViews > 0 ? avgViews / shMedianViews : 1;
    const verdict = ratio >= T.streamerBoost ? 'boost' : ratio <= T.streamerAvoid ? 'avoid' : 'ok';
    return { streamer, count: vids.length, avgViews, avgPct, ratio, verdict };
  })
  .sort((a, b) => b.avgViews - a.avgViews);

// ── Ретеншн: найбільший провал у першій половині ────────────────────────────
function biggestDrop(curve) {
  if (!curve || curve.length < 5) return null;
  let worst = null;
  for (let i = 1; i < curve.length && curve[i].ratio <= 0.6; i++) {
    const drop = curve[i - 1].watchRatio - curve[i].watchRatio;
    if (!worst || drop > worst.drop) worst = { drop, ratio: curve[i].ratio };
  }
  return worst && worst.drop >= 0.05 ? worst : null; // <5пп за крок — не провал
}

// ── Рекомендації (rule-based) ───────────────────────────────────────────────
const recs = [];
const push = (level, text) => recs.push({ level, text });

if (maturedEp.length >= 3) {
  if (kpi.epViewPct < T.epViewPctWarn)
    push('bad', `Утримання лонгформу ${fmtPct(kpi.epViewPct)} — нижче ${T.epViewPctWarn}%. Перевір перші 30 секунд: найсильніший кліп має йти першим; розглянь cold open (тизер найкращого моменту перед інтро).`);
  else if (kpi.epViewPct >= T.epViewPctGood)
    push('good', `Утримання лонгформу ${fmtPct(kpi.epViewPct)} — вище цілі ${T.epViewPctGood}%. Структура епізоду працює, не змінюй порядок подачі.`);
  else
    push('mid', `Утримання лонгформу ${fmtPct(kpi.epViewPct)} — між ${T.epViewPctWarn}% і ${T.epViewPctGood}%. Є запас: подивись на криві ретеншну нижче, де саме відвалюються глядачі.`);

  const conv = kpi.epViews > 0 ? sum(maturedEp, v => v.window?.subscribersGained) / kpi.epViews * 100 : 0;
  if (conv >= T.subsConvGood) push('good', `Конверсія в підписку ${conv.toFixed(2)}% — ціль ≥${T.subsConvGood}% виконується.`);
  else push('mid', `Конверсія в підписку ${conv.toFixed(2)}% (ціль ≥${T.subsConvGood}%). Перевір що заклик в описі/кінці відео на місці; додай закріплений коментар з питанням.`);
}

if (maturedSh.length >= 5) {
  if (kpi.shViewPct >= T.shViewPctGood)
    push('good', `Шортси в середньому додивляються на ${fmtPct(kpi.shViewPct)} — лупляться, алгоритм це любить.`);
  else if (kpi.shViewPct < T.shViewPctWarn)
    push('bad', `Шортси додивляються лише на ${fmtPct(kpi.shViewPct)} (ціль ≥${T.shViewPctGood}%). Хук перших 1-2 секунд слабкий або кліпи задовгі — ріж одразу після панчлайна, без aftermath.`);
}

for (const s of streamerRows) {
  if (s.verdict === 'boost')
    push('good', `Стрімер ${esc(s.streamer)}: шортси в середньому ${fmtN(s.avgViews)} переглядів (${s.ratio.toFixed(1)}× медіани, ${s.count} шт). Бери його кліпи частіше і став першими в епізоді.`);
  if (s.verdict === 'avoid')
    push('bad', `Стрімер ${esc(s.streamer)}: ${fmtN(s.avgViews)} переглядів (${s.ratio.toFixed(1)}× медіани, ${s.count} шт). Аудиторія не реагує — знизити пріоритет у відборі.`);
}

for (const v of maturedEp) {
  const drop = biggestDrop(v.retention);
  if (drop) {
    const t = fmtMMSS(drop.ratio * v.durationSec);
    push('bad', `«${esc(v.title.slice(0, 60))}»: провал утримання −${(drop.drop * 100).toFixed(0)}пп на ${t} (${(drop.ratio * 100).toFixed(0)}% відео). Подивись який кліп стоїть у цій позиції — такий тип моменту/стрімера вбиває сесію.`);
  }
}

const ctrVideos = perf.videos.filter(v => v.ctr?.ctr != null);
if (ctrVideos.length) {
  const avgCtr = avg(ctrVideos, v => v.ctr.ctr);
  if (avgCtr >= T.ctrGood) push('good', `CTR (ручні дані, ${ctrVideos.length} відео): ${avgCtr.toFixed(1)}% — ціль ≥${T.ctrGood}% виконується.`);
  else if (avgCtr < T.ctrWarn) push('bad', `CTR ${avgCtr.toFixed(1)}% — нижче ${T.ctrWarn}%. Превю не чіпляє: більше емоції на обличчі, менше слів у хуку, перевір читабельність на 200px.`);
  else push('mid', `CTR ${avgCtr.toFixed(1)}% (ціль ≥${T.ctrGood}%). Продовжуй Test & Compare у Studio на кожному епізоді.`);
} else {
  push('mid', 'CTR недоступний через API. Раз на тиждень перенеси цифри зі Studio в analytics/manual-ctr.json — {"<videoId>": {"impressions": N, "ctr": X.X}} — і CTR з’явиться у звіті.');
}

if (recs.length === 0) push('mid', 'Замало «дозрілих» даних (відео молодші за 3 дні або вікно порожнє). Запусти pull-analytics знову за кілька днів.');

// ── Рендер HTML ─────────────────────────────────────────────────────────────
function retentionSvg(curve, durationSec) {
  if (!curve || curve.length < 3) return '';
  const W = 160, H = 36;
  const pts = curve.map(p => `${(p.ratio * W).toFixed(1)},${(H - Math.min(1, p.watchRatio) * H).toFixed(1)}`).join(' ');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="vertical-align:middle"><polyline points="${pts}" fill="none" stroke="#f5ff3d" stroke-width="1.5"/></svg>`;
}

const verdictBadge = v => v === 'boost'
  ? '<span class="badge good">більше</span>'
  : v === 'avoid' ? '<span class="badge bad">менше</span>' : '<span class="badge">ok</span>';

const levelIcon = { good: '✅', mid: '⚠️', bad: '❌' };

const epRows = episodes.map(v => {
  const w = v.window || {};
  const drop = biggestDrop(v.retention);
  return `<tr>
    <td>${esc((v.publishedAt || '').slice(0, 10))}</td>
    <td><a href="https://youtu.be/${esc(v.videoId)}" target="_blank">${esc(v.title.slice(0, 70))}</a></td>
    <td class="num">${fmtN(w.views)}</td>
    <td class="num">${w.averageViewDuration != null ? fmtMMSS(w.averageViewDuration) : '—'}</td>
    <td class="num">${fmtPct(w.averageViewPercentage)}</td>
    <td class="num">${fmtN(w.subscribersGained)}</td>
    <td class="num">${v.ctr?.ctr != null ? v.ctr.ctr.toFixed(1) + '%' : '—'}</td>
    <td>${retentionSvg(v.retention, v.durationSec)}${drop ? ` <span class="bad-text">−${(drop.drop * 100).toFixed(0)}пп @ ${fmtMMSS(drop.ratio * v.durationSec)}</span>` : ''}</td>
  </tr>`;
}).join('\n');

const shSorted = [...shorts].sort((a, b) => (b.window?.views || 0) - (a.window?.views || 0));
const shRows = shSorted.slice(0, 25).map(v => {
  const w = v.window || {};
  return `<tr>
    <td>${esc((v.publishedAt || '').slice(0, 10))}</td>
    <td><a href="https://youtube.com/shorts/${esc(v.videoId)}" target="_blank">${esc(v.title.slice(0, 60))}</a></td>
    <td>${esc(v.streamer || '—')}</td>
    <td>${esc(v.game || '—')}</td>
    <td class="num">${fmtN(w.views)}</td>
    <td class="num">${fmtPct(w.averageViewPercentage)}</td>
    <td class="num">${fmtN(w.likes)}</td>
  </tr>`;
}).join('\n');

const streamerRowsHtml = streamerRows.map(s => `<tr>
  <td>${esc(s.streamer)}</td>
  <td class="num">${s.count}</td>
  <td class="num">${fmtN(s.avgViews)}</td>
  <td class="num">${fmtPct(s.avgPct)}</td>
  <td class="num">${s.ratio.toFixed(2)}×</td>
  <td>${verdictBadge(s.verdict)}</td>
</tr>`).join('\n');

const trafficRows = (perf.trafficSources || []).map(t =>
  `<tr><td>${esc(t.source)}</td><td class="num">${fmtN(t.views)}</td><td class="num">${fmtN(t.minutesWatched)} хв</td></tr>`).join('\n');

const recsHtml = recs.map(r => `<li class="rec ${r.level}">${levelIcon[r.level]} ${r.text}</li>`).join('\n');

const html = `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DDOS Analytics — ${esc(perf.endDate)}</title>
<style>
  :root { --bg:#0e0e10; --fg:#f4f0e6; --accent:#f5ff3d; --dim:#8a8a92; --card:#1a1a1e; --good:#5dd39e; --bad:#ff6b6b; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--fg); font:15px/1.55 'Segoe UI',system-ui,sans-serif; padding:32px; max-width:1200px; margin:0 auto; }
  h1 { font-size:26px; margin-bottom:4px; } h1 span { color:var(--accent); }
  h2 { font-size:18px; margin:36px 0 12px; border-bottom:2px solid var(--accent); display:inline-block; padding-bottom:2px; }
  .sub { color:var(--dim); margin-bottom:24px; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .kpi { background:var(--card); border-radius:10px; padding:14px 16px; }
  .kpi .v { font-size:24px; font-weight:700; color:var(--accent); }
  .kpi .l { font-size:12px; color:var(--dim); text-transform:uppercase; letter-spacing:.5px; }
  table { border-collapse:collapse; width:100%; font-size:13.5px; }
  th { text-align:left; color:var(--dim); font-weight:600; padding:8px 10px; border-bottom:1px solid #2a2a30; white-space:nowrap; }
  td { padding:7px 10px; border-bottom:1px solid #1e1e24; vertical-align:middle; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  a { color:var(--fg); text-decoration:none; border-bottom:1px dotted var(--dim); } a:hover { color:var(--accent); }
  .badge { background:#2a2a30; border-radius:6px; padding:2px 8px; font-size:12px; }
  .badge.good { background:rgba(93,211,158,.15); color:var(--good); }
  .badge.bad { background:rgba(255,107,107,.15); color:var(--bad); }
  .bad-text { color:var(--bad); font-size:12px; }
  ul.recs { list-style:none; display:flex; flex-direction:column; gap:10px; }
  li.rec { background:var(--card); border-radius:10px; padding:12px 16px; border-left:4px solid var(--dim); }
  li.rec.good { border-left-color:var(--good); } li.rec.bad { border-left-color:var(--bad); } li.rec.mid { border-left-color:var(--accent); }
  .tablewrap { overflow-x:auto; }
  .note { color:var(--dim); font-size:12.5px; margin-top:8px; }
</style></head><body>
  <h1>Daily Dose Of Stream — <span>Analytics</span></h1>
  <div class="sub">Вікно: ${esc(perf.startDate)} → ${esc(perf.endDate)} (${perf.windowDays} дн) · оновлено ${esc((perf.pulledAt || '').slice(0, 16).replace('T', ' '))} · дані YouTube мають лаг ~48 год</div>

  <div class="kpis">
    <div class="kpi"><div class="v">${kpi.epCount} / ${kpi.shCount}</div><div class="l">епізодів / шортсів</div></div>
    <div class="kpi"><div class="v">${fmtN(kpi.epViews)}</div><div class="l">перегляди лонгформ</div></div>
    <div class="kpi"><div class="v">${fmtN(kpi.shViews)}</div><div class="l">перегляди шортси</div></div>
    <div class="kpi"><div class="v">${fmtPct(kpi.epViewPct)}</div><div class="l">утримання епізодів</div></div>
    <div class="kpi"><div class="v">${fmtPct(kpi.shViewPct)}</div><div class="l">додивлення шортсів</div></div>
    <div class="kpi"><div class="v">${fmtN(kpi.subsGained)}</div><div class="l">підписників +</div></div>
    <div class="kpi"><div class="v">${fmtN(trend.viewsNow)}${trendArrow(trend.viewsNow, trend.viewsPrev)}</div><div class="l">views/епізод 7д vs раніше (${fmtN(trend.viewsPrev)})</div></div>
  </div>

  <h2>Що робити (рекомендації)</h2>
  <ul class="recs">${recsHtml}</ul>

  <h2>Епізоди</h2>
  <div class="tablewrap"><table>
    <tr><th>Дата</th><th>Назва</th><th class="num">Views</th><th class="num">AVD</th><th class="num">Утрим.</th><th class="num">Subs+</th><th class="num">CTR</th><th>Ретеншн (перші 7 дн)</th></tr>
    ${epRows || '<tr><td colspan="8">Немає епізодів у вікні</td></tr>'}
  </table></div>
  <div class="note">Ретеншн-крива: жовта лінія = частка аудиторії, що ще дивиться, по ходу відео. Провал = позиція кліпу, який виганяє глядачів.</div>

  <h2>Шортси — топ за переглядами</h2>
  <div class="tablewrap"><table>
    <tr><th>Дата</th><th>Назва</th><th>Стрімер</th><th>Гра</th><th class="num">Views</th><th class="num">Додивл.</th><th class="num">Likes</th></tr>
    ${shRows || '<tr><td colspan="7">Немає шортсів у вікні</td></tr>'}
  </table></div>

  <h2>Стрімери у шортсах (≥${T.minShortsPerStreamer} шт, медіана = ${fmtN(shMedianViews)} views)</h2>
  <div class="tablewrap"><table>
    <tr><th>Стрімер</th><th class="num">Шортсів</th><th class="num">Сер. views</th><th class="num">Додивл.</th><th class="num">vs медіана</th><th>Вердикт</th></tr>
    ${streamerRowsHtml || '<tr><td colspan="6">Замало даних (потрібно ≥2 шортси на стрімера з ledger-мапінгом)</td></tr>'}
  </table></div>

  <h2>Джерела трафіку (канал, за вікно)</h2>
  <div class="tablewrap"><table>
    <tr><th>Джерело</th><th class="num">Views</th><th class="num">Watch time</th></tr>
    ${trafficRows || '<tr><td colspan="3">Немає даних</td></tr>'}
  </table></div>
</body></html>`;

const outPath = path.join(ANALYTICS_DIR, 'index.html');
fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
fs.writeFileSync(outPath, html, 'utf8');
console.log(`[REPORT] ${outPath} — ${episodes.length} епізодів, ${shorts.length} шортсів, ${recs.length} рекомендацій`);
