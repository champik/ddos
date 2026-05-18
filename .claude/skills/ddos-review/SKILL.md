# Skill: ddos-review

Згенеруй локальну HTML сторінку для перегляду і апруву епізоду.

---

## Генерація review.html

```bash
node scripts/progress.js "projects/<runId>" 15 "Генерую review.html"
```

Запустити готовий скрипт:

```bash
node scripts/gen-review.js "projects/<runId>"
```

Скрипт читає episode-plan.json, metadata.json, scored-clips.json і генерує повну сторінку review/review.html.

**Секції сторінки:** header, long-form video, thumbnail, title options (клікабельні картки), таблиця кліпів (DDOS/Funny/Shorts/Views/Flags), shorts grid (9:16 vertical), metadata block, approve box.

**Стиль:** #0e0e10 фон, #f4f0e6 текст, #f5ff3d акцент, Anton/Space Grotesk/JetBrains Mono.

Після генерації вивести в чат:
```
✓ Review page готова
Відкрий: projects/<runId>/review/review.html
```

```bash
node scripts/progress.js "projects/<runId>" summary
```

Оновити `state.stages.review = "done"`.

---

## Оновлення projects/index.html

Після генерації review.html — оновити `projects/index.html`:

1. Зчитай `projects/index.html`
2. Перевір чи картка цього епізоду вже існує (шукай `EP #N` де N = episodeNumber) — якщо так, пропусти
3. Якщо не існує — вставити новий `<div class="episode-card">` одразу після рядка `<div class="subtitle">...</div>`, перед усіма існуючими картками (щоб новий епізод був першим)

### Шаблон картки

```html
<!-- EPISODE N -->
<div class="episode-card">
  <div class="thumb-wrap">
    <a href="<projectFolder>/review/review.html">
      <img src="<projectFolder>/exports/thumbnail.png" alt="Episode N thumbnail">
    </a>
    <div class="ep-badge">EP #N</div>
  </div>
  <div class="info">
    <div class="info-top">
      <div class="episode-num">Episode N &nbsp;·&nbsp; YYYY-MM-DD</div>
      <div class="title"><titleOptions[0]></div>
      <div class="title-alts">
        <span><titleOptions[1]></span>
        <span><titleOptions[2]></span>
      </div>
    </div>
    <hr class="divider">
    <div class="meta-row">
      <span class="date"><runId></span>
      <span class="status-pending">⏳ pending</span>
      <span class="shorts-count"><shortsCount> shorts</span>
    </div>
    <div class="links-row">
      <a class="btn btn-review" href="<projectFolder>/review/review.html">Review</a>
    </div>
  </div>
</div>
```

- `status-pending` → буде замінено на `status-published` при `/ddos approve`
- `shortsCount` = кількість шортів з `edit/shorts-selection.json` (або 0 якщо файл відсутній)
- YouTube посилання додаються при `/ddos approve` (після отримання `youtubeVideoId`)
