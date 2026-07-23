# Custom-Hours Ingest Window With Recency Compensation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a general `--hours N` flag on `scripts/ingest.js` and, when N>24, apply a fixed-tails recency-compensation mechanism (hours-ago based, not calendar-day based) so `/run <N>` works correctly for any custom window length, while `/run` (no arg, N=24) stays byte-for-byte identical to today.

**Architecture:** Two pure helper functions (`buildHourWindows`, `hourRecencyWindows`) added to `scripts/lib/select.js`, unit-tested with a plain-Node assert script (no test framework in this repo). `scripts/ingest.js` restores `--hours N` parsing, scales Twitch API page counts with N, and — only when N>24 — layers recency-window picks on top of the existing base+diversity-floor SELECT output. `.claude/commands/run.md` gains positional-number parsing (`/run 120` → `--hours 120`) and `.claude/skills/ddos-ingest/SKILL.md` documents the new behavior.

**Tech Stack:** Node.js (no dependencies beyond what's already in the repo), plain `assert`-based test scripts (matches existing repo convention of zero test framework).

**Design doc:** `docs/superpowers/specs/2026-07-07-custom-hours-recency-ingest-design.md`

---

### Task 1: Add `buildHourWindows` / `hourRecencyWindows` to `scripts/lib/select.js`

**Files:**
- Modify: `scripts/lib/select.js`
- Test: `scripts/lib/select.test.js` (new)

- [ ] **Step 1: Write the test file**

Create `scripts/lib/select.test.js`:

```javascript
'use strict';
const assert = require('assert');
const { buildHourWindows, hourRecencyWindows } = require('./select');

let failed = false;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failed = true; console.error(`  FAIL - ${name}\n    ${e.message}`); }
}

console.log('buildHourWindows');

test('N=24 returns no windows (recency disabled at the default window)', () => {
  assert.deepStrictEqual(buildHourWindows(24), []);
});

test('N<24 returns no windows', () => {
  assert.deepStrictEqual(buildHourWindows(12), []);
});

test('N=48 returns new + mid (mid truncated to [24,48)), no old', () => {
  const w = buildHourWindows(48);
  assert.strictEqual(w.length, 2);
  assert.deepStrictEqual(w[0], { minHoursAgo: 0, maxHoursAgo: 24, jcirlSlots: 15, gamingSlots: 8 });
  assert.deepStrictEqual(w[1], { minHoursAgo: 24, maxHoursAgo: 48, jcirlSlots: 10, gamingSlots: 5 });
});

test('N=72 returns new + full 48h mid, no old (boundary excluded)', () => {
  const w = buildHourWindows(72);
  assert.strictEqual(w.length, 2);
  assert.deepStrictEqual(w[1], { minHoursAgo: 24, maxHoursAgo: 72, jcirlSlots: 10, gamingSlots: 5 });
});

test('N=120 returns all three windows matching the spec example (48/48/24 -> 5/10/15)', () => {
  const w = buildHourWindows(120);
  assert.strictEqual(w.length, 3);
  assert.deepStrictEqual(w[0], { minHoursAgo: 0,  maxHoursAgo: 24,  jcirlSlots: 15, gamingSlots: 8 });
  assert.deepStrictEqual(w[1], { minHoursAgo: 24, maxHoursAgo: 72,  jcirlSlots: 10, gamingSlots: 5 });
  assert.deepStrictEqual(w[2], { minHoursAgo: 72, maxHoursAgo: 120, jcirlSlots: 5,  gamingSlots: 2 });
});

test('N=240 old window spans to N with the same fixed slot target', () => {
  const w = buildHourWindows(240);
  assert.strictEqual(w[2].maxHoursAgo, 240);
  assert.strictEqual(w[2].jcirlSlots, 5);
  assert.strictEqual(w[2].gamingSlots, 2);
});

console.log('hourRecencyWindows');

test('adds up to target slots per window, skips already-selected, ranks by view_count', () => {
  const now = Date.parse('2026-07-07T12:00:00Z');
  const hoursAgo = h => new Date(now - h * 3600000).toISOString();
  const pool = [
    { id: 'a', created_at: hoursAgo(1),  view_count: 50 },   // new window
    { id: 'b', created_at: hoursAgo(2),  view_count: 100 },  // new window, higher views
    { id: 'c', created_at: hoursAgo(30), view_count: 10 },   // mid window
    { id: 'd', created_at: hoursAgo(80), view_count: 5 },    // old window
  ];
  const windows = buildHourWindows(120);
  const picked = hourRecencyWindows(pool, [{ id: 'b' }], now, windows, 'jcirlSlots');
  const ids = picked.map(c => c.id);
  assert.ok(!ids.includes('b'), 'already-selected clip must be excluded');
  assert.ok(ids.includes('a'), 'new-window clip must be picked when b is excluded');
  assert.ok(ids.includes('c'), 'mid-window clip must be picked');
  assert.ok(ids.includes('d'), 'old-window clip must be picked');
});

test('caps at slot target even with more eligible clips in one window', () => {
  const now = Date.parse('2026-07-07T12:00:00Z');
  const hoursAgo = h => new Date(now - h * 3600000).toISOString();
  // 20 clips all in the "old" window (72-120h ago), which only targets 5 slots
  const pool = Array.from({ length: 20 }, (_, i) => ({
    id: `x${i}`, created_at: hoursAgo(80), view_count: 20 - i,
  }));
  const windows = buildHourWindows(120);
  const picked = hourRecencyWindows(pool, [], now, windows, 'jcirlSlots');
  assert.strictEqual(picked.length, 5);
  assert.strictEqual(picked[0].id, 'x0'); // highest view_count first
});

test('gamingSlots key uses the smaller gaming targets', () => {
  const now = Date.parse('2026-07-07T12:00:00Z');
  const hoursAgo = h => new Date(now - h * 3600000).toISOString();
  const pool = Array.from({ length: 20 }, (_, i) => ({
    id: `g${i}`, created_at: hoursAgo(1), view_count: 20 - i,
  }));
  const windows = buildHourWindows(120);
  const picked = hourRecencyWindows(pool, [], now, windows, 'gamingSlots');
  assert.strictEqual(picked.length, 8); // new window gamingSlots = 8
});

if (failed) {
  console.error('\nSELECT TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nAll select.test.js checks passed.');
}
```

- [ ] **Step 2: Run the test to verify it fails (functions don't exist yet)**

Run: `node scripts/lib/select.test.js`
Expected: `TypeError` — `buildHourWindows is not a function` (or similar), process exits non-zero.

- [ ] **Step 3: Implement `buildHourWindows` and `hourRecencyWindows` in `scripts/lib/select.js`**

Add to the end of `scripts/lib/select.js`, before the `module.exports` line:

```javascript
// Fixed-tail hour windows for custom --hours N ingest ranges (N > 24).
// Anchored to fixed "hours ago" marks (24, 72) rather than scaled proportionally
// to N, mirroring how /run month's day-of-month windows don't scale with month length.
// Design: docs/superpowers/specs/2026-07-07-custom-hours-recency-ingest-design.md
function buildHourWindows(hours) {
  if (hours <= 24) return [];
  const windows = [
    { minHoursAgo: 0,  maxHoursAgo: Math.min(24, hours), jcirlSlots: 15, gamingSlots: 8 },
    { minHoursAgo: 24, maxHoursAgo: Math.min(72, hours), jcirlSlots: 10, gamingSlots: 5 },
  ];
  if (hours > 72) {
    windows.push({ minHoursAgo: 72, maxHoursAgo: hours, jcirlSlots: 5, gamingSlots: 2 });
  }
  return windows;
}

// Recency compensation: per window, pick up to its slot target by popularity,
// excluding clips already in alreadySelected (or picked by an earlier window in
// this same call). slotsKey selects 'jcirlSlots' or 'gamingSlots' from each window.
function hourRecencyWindows(pool, alreadySelected, nowMs, windows, slotsKey) {
  const pickedIds = new Set(alreadySelected.map(c => c.id));
  const result = [];

  for (const w of windows) {
    const slots = w[slotsKey];
    if (!slots) continue;

    const eligible = pool
      .filter(c => !pickedIds.has(c.id))
      .filter(c => {
        const hoursAgo = (nowMs - new Date(c.created_at).getTime()) / 3600000;
        return hoursAgo >= w.minHoursAgo && hoursAgo < w.maxHoursAgo;
      })
      .sort((a, b) => b.view_count - a.view_count);

    let added = 0;
    for (const c of eligible) {
      if (added >= slots) break;
      result.push(c);
      pickedIds.add(c.id);
      added++;
    }
  }

  return result;
}
```

Update the `module.exports` line at the bottom of the file:

```javascript
module.exports = { pickByPopularity, diversityFloor, buildHourWindows, hourRecencyWindows };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/lib/select.test.js`
Expected: every line prefixed `ok -`, ending with `All select.test.js checks passed.`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/select.js scripts/lib/select.test.js
git commit -m "$(cat <<'EOF'
Add hour-based recency-window helpers to lib/select.js

buildHourWindows/hourRecencyWindows generalize /run month's recency
compensation to arbitrary --hours N ranges, anchored to fixed hours-ago
marks (24/72) instead of calendar day-of-month.
EOF
)"
```

---

### Task 2: Wire `--hours N` and recency compensation into `scripts/ingest.js`

**Files:**
- Modify: `scripts/ingest.js`

- [ ] **Step 1: Restore the `--hours` flag and usage comment**

Find (near the top of the file):

```javascript
#!/usr/bin/env node
// DDOS Pipeline — INGEST + FILTER + SELECT
// Usage: node scripts/ingest.js <runId> <token>
```

Replace with:

```javascript
#!/usr/bin/env node
// DDOS Pipeline — INGEST + FILTER + SELECT
// Usage: node scripts/ingest.js <runId> <token> [--hours N]
```

Find:

```javascript
const HOURS = 24;
const MAX_CANDIDATES = 500;
```

Replace with:

```javascript
const hoursArg = flags.indexOf('--hours');
const HOURS = hoursArg >= 0 ? parseInt(flags[hoursArg + 1], 10) : 24;
const MAX_CANDIDATES = 500;
```

- [ ] **Step 2: Import the new select.js helpers**

Find:

```javascript
const { pickByPopularity, diversityFloor } = require('./lib/select');
```

Replace with:

```javascript
const { pickByPopularity, diversityFloor, buildHourWindows, hourRecencyWindows } = require('./lib/select');
```

- [ ] **Step 3: Capture a single `nowMs` reference and scale page counts**

Find:

```javascript
async function main() {
  const startedAt = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();
  console.log(`[INGEST] runId=${runId} started_at=${startedAt}`);
```

Replace with:

```javascript
async function main() {
  const nowMs = Date.now();
  const startedAt = new Date(nowMs - HOURS * 3600 * 1000).toISOString();
  console.log(`[INGEST] runId=${runId} started_at=${startedAt}${HOURS !== 24 ? ` hours=${HOURS}` : ''}`);

  // Page counts scale with window length so longer ranges don't under-sample
  // the pool (fixed at 24h-equivalent 3/1 pages would starve recency windows).
  const JCIRL_PAGES = Math.min(15, Math.ceil(3 * HOURS / 24));
  const OTHER_PAGES = Math.min(6, Math.ceil(HOURS / 24));
```

Find:

```javascript
  const jcIrlCursors = {};
  for (const cat of allCategories) {
    const pages = JCIRL_IDS.has(cat.id) ? 3 : 1;
```

Replace with:

```javascript
  const jcIrlCursors = {};
  for (const cat of allCategories) {
    const pages = JCIRL_IDS.has(cat.id) ? JCIRL_PAGES : OTHER_PAGES;
```

- [ ] **Step 4: Apply recency-window compensation in the SELECT stage**

Find:

```javascript
  // Gaming: 50 кліпів одразу — GAMING_SCREEN перевіряє всі за один прохід.
  // ~50% відсіву очікується, тому беремо вдвічі більше від мінімуму (20).
  const gamingPick = pickByPopularity(gamingPool, { limit: 50, maxPerStreamer: 5, maxPerGame: 5 });

  const downloadedIds = new Set();
```

Replace with:

```javascript
  // Gaming: 50 кліпів одразу — GAMING_SCREEN перевіряє всі за один прохід.
  // ~50% відсіву очікується, тому беремо вдвічі більше від мінімуму (20).
  const gamingPick = pickByPopularity(gamingPool, { limit: 50, maxPerStreamer: 5, maxPerGame: 5 });

  // Recency compensation for custom --hours N > 24: adds clips on top of the
  // base+diversity-floor pick, favoring windows closer to "now" that haven't
  // had as much time to accumulate views. No-op (empty windows) when N<=24.
  const hourWindows = buildHourWindows(HOURS);
  let jcIrlRecency = [];
  let gamingRecency = [];
  if (hourWindows.length > 0) {
    jcIrlRecency = hourRecencyWindows(jcIrlPool, jcIrlPick, nowMs, hourWindows, 'jcirlSlots');
    jcIrlPick = [...jcIrlPick, ...jcIrlRecency];
    gamingRecency = hourRecencyWindows(gamingPool, gamingPick, nowMs, hourWindows, 'gamingSlots');
    gamingPick.push(...gamingRecency);
    console.log(`[SELECT] Recency compensation (--hours ${HOURS}): +${jcIrlRecency.length} JC/IRL, +${gamingRecency.length} Gaming`);
  }

  const downloadedIds = new Set();
```

- [ ] **Step 5: Syntax-check the file**

Run: `node -c scripts/ingest.js`
Expected: no output (exit code 0).

- [ ] **Step 6: Commit**

```bash
git add scripts/ingest.js
git commit -m "$(cat <<'EOF'
Restore --hours N flag on ingest.js with recency compensation

For N>24, layers hour-window recency compensation (via lib/select.js)
on top of the existing base+diversity-floor SELECT pick, and scales
Twitch API page counts with N so longer windows aren't under-sampled.
N<=24 (the /run default) is unchanged.
EOF
)"
```

---

### Task 3: `/run <N>` positional-hours parsing in the slash command

**Files:**
- Modify: `.claude/commands/run.md`

- [ ] **Step 1: Document the argument and parsing order**

Find:

```markdown
## Аргументи
- `--dry-run` — тільки ingest + filter, без завантаження
- `--limit N` — максимум кандидатів (default: 500)
```

Replace with:

```markdown
## Аргументи
- `/run N` — позиційне число одразу після `/run` = кількість годин для ingest-вікна (напр. `/run 120` = останні 120 годин). Без числа — 24 години (дефолт).
- `--dry-run` — тільки ingest + filter, без завантаження
- `--limit N` — максимум кандидатів (default: 500)

**Розбір першого аргументу (перед усім іншим):**
1. Якщо перший аргумент — ключове слово `month` → це не `/ddos run`, а `/run month` (окремий skill `run-month`)
2. Якщо перший аргумент — ключове слово `special` → окремий skill `ddos-special`
3. Якщо перший аргумент парситься як ціле число → `HOURS = це число`
4. Інакше → `HOURS = 24` (дефолт)
```

- [ ] **Step 2: Pass `--hours` through to the ingest invocation**

Find:

```markdown
**Порядок:**
1. Прочитай `.claude/skills/ddos-ingest/SKILL.md` → виконай INGEST + FILTER + SELECT + DOWNLOAD
```

Replace with:

```markdown
**Порядок:**
1. Прочитай `.claude/skills/ddos-ingest/SKILL.md` → виконай INGEST + FILTER + SELECT + DOWNLOAD.
   Запусти `node scripts/ingest.js <runId> <token>` — і додай `--hours <HOURS>` тільки якщо
   `HOURS != 24` (дефолтний виклик без прапорця лишається без змін).
```

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/run.md
git commit -m "$(cat <<'EOF'
Document /run <N> positional-hours parsing

/run 120 now maps to --hours 120 on ingest.js; /run month and
/run special keywords are checked first so they aren't misparsed as hours.
EOF
)"
```

---

### Task 4: Update `ddos-ingest` skill documentation

**Files:**
- Modify: `.claude/skills/ddos-ingest/SKILL.md`

- [ ] **Step 1: Document the actual script invocation and scaled page counts**

Find:

```markdown
### Запит кліпів

Для кожної категорії — послідовні сторінки без пропусків:

- **JC/IRL** (509658, 509672): **3 сторінки** → до 300 кліпів кожна
- **Решта категорій**: **1 сторінка** → до 100 кліпів кожна

```
GET https://api.twitch.tv/helix/clips
  ?game_id=<gameId>
  &started_at=<ISO: now - 24 годин>
  &first=100
  &after=<cursor>
```

Зберегти у `clips/raw-clips.json`. Оновити `state.counts.raw`.
```

Replace with:

```markdown
### Запит кліпів

Реалізовано в `node scripts/ingest.js <runId> <token> [--hours N]` (дефолт N=24).

Для кожної категорії — послідовні сторінки без пропусків. Кількість сторінок
масштабується з N (щоб довші вікна не отримували неповний пул):

```
pages_JCIRL  = min(15, ceil(3 × N / 24))   → N=24: 3,  N=120: 15, N=240: 15 (кап)
pages_OTHER  = min(6,  ceil(N / 24))       → N=24: 1,  N=120: 5,  N=240: 6  (кап)
```

```
GET https://api.twitch.tv/helix/clips
  ?game_id=<gameId>
  &started_at=<ISO: now - N годин>
  &first=100
  &after=<cursor>
```

Зберегти у `clips/raw-clips.json`. Оновити `state.counts.raw`.
```

- [ ] **Step 2: Document recency compensation for N>24 in the SELECT section**

Find:

```markdown
Зберегти у `clips/prescore-candidates.json` (150 кандидатів: 100 JC/IRL + 50 Gaming).
Оновити `state.stages.select = "done"`.
```

Replace with:

```markdown
**Recency-компенсація (тільки якщо `--hours N` > 24):**

Три вікна, прив'язані до фіксованих позначок "годин тому" (не пропорційні до N):

| Вікно | Діапазон (hours-ago) | Активне коли | JC/IRL | Gaming |
|---|---|---|---|---|
| new | `[0, min(24,N))`  | N > 24 | +15 | +8 |
| mid | `[24, min(72,N))` | N > 24 | +10 | +5 |
| old | `[72, N)`          | N > 72 | +5  | +2 |

Слоти додаються **зверху** базового пулу (100 JC/IRL / 50 Gaming вище), з
кліпів що ще не обрані. Деталі: `docs/superpowers/specs/2026-07-07-custom-hours-recency-ingest-design.md`.

Зберегти у `clips/prescore-candidates.json` (150 кандидатів за замовчуванням
N=24: 100 JC/IRL + 50 Gaming; більше при N>24 через recency-компенсацію).
Оновити `state.stages.select = "done"`.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/ddos-ingest/SKILL.md
git commit -m "$(cat <<'EOF'
Document --hours N page scaling and recency compensation in ddos-ingest skill
EOF
)"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the unit test suite**

Run: `node scripts/lib/select.test.js`
Expected: `All select.test.js checks passed.`, exit code 0.

- [ ] **Step 2: Syntax-check ingest.js**

Run: `node -c scripts/ingest.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Confirm default 24h path is untouched**

Run: `node -e "const {buildHourWindows}=require('./scripts/lib/select'); console.log(JSON.stringify(buildHourWindows(24)))"`
Expected output: `[]`

- [ ] **Step 4 (manual, requires a real TWITCH_TOKEN in `.env`): live smoke test**

Run: `node scripts/ingest.js Test_Hours48_2026_07_07 --hours 48` (uses `TWITCH_TOKEN` env var, no `tokenArg` needed if set)
Expected in output: a `[SELECT] Recency compensation (--hours 48): +X JC/IRL, +Y Gaming` line where Y ≤ 5 (no old-window contribution at N=48) and X ≤ 10. Inspect `projects/.../Test_Hours48_2026_07_07/clips/prescore-candidates.json` for no duplicate `id` values across the full list.

This step depends on live Twitch credentials and network access — skip if unavailable in the current environment, but run it before relying on `/run <N>` for a real episode.
