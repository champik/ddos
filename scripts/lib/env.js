'use strict';
// env.js — спільне завантаження .env з кореня репозиторію.
// Відсутній .env — не помилка (змінні можуть бути задані в оточенні),
// але попереджаємо, щоб "мовчазний" запуск без ключів було видно одразу.

const fs = require('fs');

function loadEnv(file = '.env') {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    console.warn(`[ENV] ${file} не знайдено — використовую тільки змінні оточення`);
    return false;
  }
  for (const line of raw.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) process.env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return true;
}

module.exports = { loadEnv };
