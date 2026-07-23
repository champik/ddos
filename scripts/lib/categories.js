'use strict';
// categories.js — єдине джерело правди для game-id груп.
// Використовується в ingest.js (CORE + SELECT), gaming-screen.js (backfill),
// gen-editorial.js (групування) та youtube-upload.js (вибір YouTube categoryId).

// Core-категорії — завжди фетчаться при INGEST
const CORE_CATEGORIES = [
  { id: '509658',    name: 'Just Chatting' },
  { id: '509672',    name: 'IRL' },
  { id: '26936',     name: 'Music' },
  { id: '116747788', name: 'Pools, Hot Tubs, and Beaches' },
  { id: '32399',     name: 'Counter-Strike 2' },
  { id: '516575',    name: 'Valorant' },
  { id: '21779',     name: 'League of Legends' },
  { id: '29595',     name: 'Dota 2' },
  { id: '493057',    name: 'PUBG: BATTLEGROUNDS' },
];

const JCIRL_IDS = new Set(['509658', '509672']);
const SPECIALTY_IDS = new Set(['26936', '116747788']);

// Розширений specialty-список: Food, Fitness, Talk Shows можуть з'явитись
// через dynamic top-10 ingest. Разом з JC/IRL — все, що НЕ gaming
// (для вибору YouTube categoryId: Entertainment vs Gaming).
const NON_GAMING_IDS = new Set([
  ...JCIRL_IDS, ...SPECIALTY_IDS,
  '509667', // Food & Drink
  '509671', // Fitness & Health
  '417752', // Talk Shows & Podcasts
]);

module.exports = { CORE_CATEGORIES, JCIRL_IDS, SPECIALTY_IDS, NON_GAMING_IDS };
