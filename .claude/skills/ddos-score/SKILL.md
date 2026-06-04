# Skill: ddos-score

> **Цей skill більше не виконує scoring.** TRANSCRIBE, SCORE і PEAK MOMENT видалені.
> GENERATE_EDITORIAL тепер викликається напряму з `run.md` через `node scripts/gen-editorial.js`.

---

## GENERATE_EDITORIAL — Генерація edit.html

```bash
node scripts/progress.js "projects/<runId>" 4 "Генерую editorial UI"
```

```bash
node scripts/gen-editorial.js <runId>
```

Скрипт:
- Читає `clips/downloaded-clips.json`
- Сортує кліпи: JC/IRL → Gaming → Music/Specialty, в межах групи по `view_count` desc
- Генерує `edit/edit.html` (інтерактивний UI для відбору кліпів)
- Записує `clips/scored-clips.json` (копія downloaded-clips для downstream compat)
- Оновлює `state.json` і `projects/index.html`

Відкрити браузер:
```bash
start "" "d:\Projects\ddos\projects\<runId>\edit\edit.html"
```

Показати користувачу:

✅ Editorial UI відкрито у браузері (`projects/<runId>/edit/edit.html`)

Переглянь кліпи, внеси правки і натисни "Copy Prompt".
Потім встав JSON сюди для продовження.

Зупинитись і чекати на JSON від користувача.
