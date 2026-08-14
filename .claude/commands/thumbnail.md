# Команда: /thumbnail

Швидкий ручний рендер обкладинки: скріншот `assets/thumbnail-template/thumbnail.html`
рівно як він є на диску — без жодної підстановки картинки чи хука з мого боку.
Користувач сам вручну редагує headline-текст у HTML і сам кладе фонове зображення
як `assets/thumbnail-template/thumbnail.png` перед запуском команди.

## Використання
```
/thumbnail
```
Без аргументів. Ніяких параметрів не приймає — усе вже підготовлено користувачем
у самому шаблоні.

## Виконання

1. Визначити останній активний (не `published`) запуск: перебрати `findAllProjects()`
   (`scripts/lib/project-path.js`), взяти найновіший за `startedAt` у `state.json`,
   чий `status !== "published"` (та сама логіка, що й у `/ddos status` без аргументу).
2. Запустити:
   ```bash
   node scripts/screenshot-thumbnail.js "<projectDir>/exports/thumbnail.png"
   ```
   Скрипт відкриває `assets/thumbnail-template/thumbnail.html` через Puppeteer 1:1
   (жодних заміни картинки/тексту), знімає скріншот 1920×1080 і зберігає в
   `exports/thumbnail.png` вказаного епізоду — перезаписуючи, якщо файл вже існує.
3. Повідомити шлях до збереженого файлу.

Ніяких Higgsfield-викликів, AI-очищення чи оверлею хука тут немає — це окремий,
швидший шлях повз `ddos-thumbnail` skill, для випадків коли користувач хоче сам
повністю контролювати картинку й текст прямо в HTML.
