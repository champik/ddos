'use strict';
// timeline.js — єдине джерело правди для порядку кліпів, позицій reconnect і таймкодів.
// Reconnect-позиції беруться ТІЛЬКИ з editorial.json (reconnectPositions + '__recon' маркери
// у clipOrder) — так само, як їх вставляє build-concat.js у фінальне відео.

// clipIds після яких грає reconnecting.mp4
function reconnectAfterSet(editorial) {
  const set = new Set(editorial.reconnectPositions || []);
  const order = editorial.clipOrder || [];
  for (let i = 1; i < order.length; i++) {
    if (String(order[i]).startsWith('__recon')) set.add(order[i - 1]);
  }
  return set;
}

// Порядок кліпів без службових '__recon' маркерів
function clipSequence(editorial) {
  return (editorial.clipOrder || []).filter(id => !String(id).startsWith('__recon'));
}

// Таймкоди розділів: нова глава на зміні стрімера, reconnect додається
// рівно там, де він реально стоїть у відео.
function buildChapters({ clipIds, reconnectAfter, getDur, getStreamer, getLabel, introDur, reconnectDur }) {
  const chapters = [];
  let offset = introDur;
  let lastStreamer = null;

  for (const clipId of clipIds) {
    const streamer = getStreamer(clipId);
    if (streamer !== lastStreamer) {
      const t = chapters.length === 0 ? 0 : Math.round(offset);
      const label = (getLabel && getLabel(clipId)) || streamer;
      chapters.push({ t, label });
      lastStreamer = streamer;
    }
    offset += getDur(clipId);
    if (reconnectAfter.has(clipId)) offset += reconnectDur;
  }
  return chapters;
}

// Сегменти кліпу після editorial — та сама розкладка, що в apply-editorial.js:
// keeps перетинаються з trim, порожні відкидаються; без keeps — один [in, out].
function editorialSegments(keeps, inT, outT) {
  if (keeps && keeps.length > 0) {
    return keeps
      .map(([s, e]) => [Math.max(s, inT), Math.min(e, outT)])
      .filter(([s, e]) => e > s);
  }
  return outT > inT ? [[inT, outT]] : [];
}

// Таймстамп у координатах ОРИГІНАЛЬНОГО кліпу → координати clean.mp4.
// Повертає null, якщо момент потрапив у вирізане або за межі trim.
//
// null тут принциповий: раніше apply-overlays.js у цьому випадку мовчки брав
// кінець останнього keep, через що -ss ставав рівним кінцю файлу і ffmpeg
// віддавав порожню перебивку з кодом 0 — епізод їхав, помилки ніхто не бачив.
function mapToCleanTimeline(t, keeps, inT = 0, outT = Infinity) {
  let acc = 0;
  for (const [s, e] of editorialSegments(keeps, inT, outT)) {
    if (t >= s && t <= e) return acc + (t - s);
    acc += (e - s);
  }
  return null;
}

module.exports = { reconnectAfterSet, clipSequence, buildChapters, editorialSegments, mapToCleanTimeline };
