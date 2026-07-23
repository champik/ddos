# Custom-hours ingest window with recency compensation

## Problem

`scripts/ingest.js` only supports a fixed 24-hour ingest window (`HOURS = 24`
hardcoded). A `--hours N` flag existed previously but was removed in commit
`faee5e5` in favor of `--ended-at` (which only shifts the *end* of the fixed
24h window, not its duration). There is currently no way to run `/run` over a
custom window such as "last 5 days" without misusing `ingest-month.js`, whose
recency-compensation algorithm is calendar-day-of-month based and only makes
sense for full-month ranges.

Goal: restore a general `--hours N` flag on `scripts/ingest.js`, and when
N > 24, apply a recency-compensation mechanism analogous to `/run month`'s,
but based on "hours ago from now" instead of calendar day-of-month — so it
works for any custom window length, not just a full month.

## Non-goals

- `ingest-month.js` is untouched. It remains the dedicated mechanism for
  `/run month` (calendar day-of-month recency windows for a full previous
  month). This design does not replace or merge with it.
- Default `/run` behavior (N ≤ 24, i.e. no `--hours` flag or `--hours 24`) is
  unchanged: 80 popularity + 20 diversity-floor JC/IRL, 50 popularity Gaming,
  no recency windows, no page-count changes.

## Window boundaries (fixed-tails algorithm)

Three windows anchored to fixed "hours-ago" marks from `now`, not scaled
proportionally to N:

| Window | Range (hours-ago) | Active when |
|---|---|---|
| new    | `[0, min(24, N))`  | N > 24 (recency enabled) |
| mid    | `[24, min(72, N))` | N > 24 |
| old    | `[72, N)`          | N > 72 |

The whole recency mechanism is gated on `N > 24`. When active, `new` and
`mid` always contribute (mid's range may be smaller than 48h if `N` is
between 24 and 72); `old` only contributes once `N > 72`.

Example (N=120, matches the original ask): old = 48h → +5, mid = 48h → +10,
new = 24h → +15.

Example (N=48): old does not exist (0 slots); mid is truncated to
`[24,48)` = 24h (still targets +10 slots, just drawn from a smaller pool);
new = `[0,24)` → +15.

## Slot counts (fixed, not scaled by N)

Mirrors `/run month`'s absolute slot counts — these do not grow with window
size, only with which windows are active:

| Window | JC/IRL | Gaming |
|---|---|---|
| new | +15 | +8 |
| mid | +10 | +5 |
| old | +5  | +2 |

Recency slots are added **on top of** the existing base pool (80 popularity +
20 diversity-floor for JC/IRL = 100; 50 popularity for Gaming), using the
combined base+diversity-floor picks as the "already picked" set so recency
windows only contribute clips not already selected.

Totals:
- N ≤ 24: 100 JC/IRL / 50 Gaming (unchanged)
- 24 < N ≤ 72: up to 125 JC/IRL / up to 63 Gaming
- N > 72: up to 130 JC/IRL / up to 65 Gaming

(Actual counts may be lower if a window doesn't have enough eligible clips to
fill its target.)

## API page-count scaling

Twitch clips pagination is currently fixed at 3 pages (JC/IRL) / 1 page
(other categories) for the 24h case. For larger N this under-samples the
pool badly, starving the recency windows (especially `old`) of candidates.
Pages scale proportionally to N with a cap:

```
pages_JCIRL = min(15, ceil(3 * N / 24))
pages_OTHER = min(6,  ceil(1 * N / 24))
```

N=24 → 3/1 (unchanged), N=120 → 15/5, N=240 → 15/6 (capped).

Estimated added ingest time for N=120 worst case (all pages fully consumed):
~19s (fixed 5/2, rejected option) vs ~47s (scaled 15/5, chosen) — acceptable
given the full `/run` pipeline runs for minutes.

## Command-line interface

### `scripts/ingest.js`

Restore `--hours N` (default 24) as a flag:
```
node scripts/ingest.js <runId> <token> [--hours N]
```
`HOURS` var is read from this flag instead of hardcoded 24. `startedAt`,
page-count formulas, and the SELECT-stage recency windows all key off `HOURS`.

### `/run` slash command

`.claude/commands/run.md` currently accepts `--dry-run`, `--limit N`. Add
positional-number recognition immediately after `/run`:

- `/run` → 24h (default, no flag passed to ingest.js)
- `/run 120` → `node scripts/ingest.js <runId> <token> --hours 120`
- `/run 48` → `--hours 48`
- `/run month` / `/run special ...` remain special keywords, checked before
  falling back to "is this a number" — parsing order: `month` keyword → hand
  off to `run-month` skill; `special` keyword → hand off to `ddos-special`
  skill; else if first arg parses as an integer → use as `--hours`; else →
  default 24.

## Implementation sketch (files touched)

- `scripts/ingest.js` — restore `--hours` flag; add recency-window
  application in the SELECT stage (after existing base+diversity-floor pick,
  before writing `prescore-candidates.json`); scale `pages` per the formula
  above.
- `scripts/lib/select.js` — add `hourRecencyWindows(pool, alreadyPicked, now, windows)`,
  an hours-ago-based analog of `ingest-month.js`'s day-of-month
  `recencyWindows`. Reuse existing `pickByPopularity`/`diversityFloor`
  unchanged.
- `.claude/commands/run.md` — document `--hours N` / positional-number
  parsing; update Крок 1 pipeline instructions.
- `.claude/skills/ddos-ingest/SKILL.md` — document scaled page-count formula
  and the new recency-window step for N>24.
- `ingest-month.js` — untouched.

## Edge cases

- `N` not an integer or ≤ 0 passed via `--hours`: fall back to default 24
  (defensive, shouldn't happen given the command-level parsing only forwards
  validated integers).
- A window (mid/old) has fewer eligible clips than its slot target: take
  whatever is available (already how `diversityFloor`/`recencyWindows`
  behave in the month script — no error, just a smaller-than-target result).
- Very large N (e.g. multi-week): page counts cap at 15/6; recency windows
  still only ever have 3 tiers (new/mid/old) — for ranges this long,
  `/run month` (or a future dedicated command) is the more appropriate tool;
  this mechanism is meant for custom rolling windows, not calendar months.

## Testing

- Unit-level: verify `hourRecencyWindows` window boundaries and slot caps for
  N = 24, 48, 72, 120, 240 against the table above.
- Manual: run `/run 48` and `/run 120` against real Twitch data (or a fixture
  pool), confirm `prescore-candidates.json` counts match expected totals per
  bucket and no duplicate clip IDs appear across base/diversity-floor/recency
  picks.
