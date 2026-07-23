'use strict';
// sys.js — крос-платформенні утиліти.

// Один спосіб резолвити python на Windows ('python') і Linux/macOS ('python3').
// Можна перевизначити через PYTHON_BIN.
function pythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  return process.platform === 'win32' ? 'python' : 'python3';
}

module.exports = { pythonBin };
