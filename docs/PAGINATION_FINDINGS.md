# Findings: data pages don't show the full selected range (worse for longer periods)

> **STATUS: FIXED.** Both defects below are resolved. `__tests__/repro/data-range-pagination.repro.test.ts`
> is now a passing regression guard, and `__tests__/api/sensors.test.ts` pins the corrected
> backend contract (short / long / boundary ranges + pagination). See "Resolution" at the bottom.

**Scope (original):** diagnosis only. One failing repro added (`__tests__/repro/data-range-pagination.repro.test.ts`). No production code changed.

## Short answer

It is **not** a frontend pagination bug. The data screen (`src/app/data/page.tsx`) does a **single** fetch with **no `limit`/`offset` paging** at all — there is no "page 2" to be missing. The range loss comes from **two backend/query-layer defects**:

| # | Layer | Defect | Why it's "worse for longer periods" |
|---|-------|--------|--------------------------------------|
| A | Backend query (`/api/sensors` GET) | **Default page-size truncation** — historical default `take: 100` with `orderBy timestamp DESC` returns only the newest 100 rows. | Data arrives ~1 row/minute, so any window > 100 min is clipped to its newest tail; the longer the window, the larger the missing fraction. |
| B | Frontend query window (`data/page.tsx` `fetchData`) | **Query-window mismatch** — custom `end` date is parsed as UTC midnight then shifted with `setHours(23,59,59,999)` in **local** time, so the selected final day is clipped/dropped in non-UTC zones. | Independent of length, but compounds A and makes "the selected range" visibly incomplete. |

## Evidence

### A — backend default page-size truncation (primary match to the symptom)

- The committed contract test still encodes the cap: `__tests__/api/sensors.test.ts` asserts `data.pagination.limit === 100` and `take: 100` as the **default**.
- `src/app/api/sensors/route.ts` GET selects `orderBy: { timestamp: 'desc' }` and applies `take` = the page size. The data screen never sends `offset`, so only the newest page is ever rendered.
- Mechanism, with ~1 SensorData row/minute (each row = one ~60-sample minute, per the POST schema):
  - 24h window = 1440 rows → newest 100 ≈ **1.7h shown of 24h** (~6.9%).
  - 7d window → newest 100 ≈ **1.7h shown of 7 days** (~1%).
  - 30d window → newest 100 ≈ **1.7h shown of 30 days** (~0.2%).
- Repro A reproduces this and asserts full-range coverage (fails): coverage collapses to minutes and shrinks as the window grows.

> Note on current source state: the working tree has partially mitigated A — `limit` now defaults to `null` (unbounded) and commit `b78ed77` added hour/6-hour **aggregation** for 7d/30d so bucket counts stay small. This change is **incomplete and inconsistent**:
> 1. The committed test suite still asserts the 100 cap, so the documented API contract and the code disagree (tests are red).
> 2. `pagination.hasMore` is hardcoded `false` whenever `limit` is null, so any future client paging silently sees "no more data".
> 3. Hourly aggregation for a 7-day range yields 168 buckets — which would **still exceed a 100-row cap**, so any environment running the pre-aggregation/capped build remains clipped for long ranges.
> 4. The unbounded raw path (used by 1h / 24h / custom ≤ 1 day) now has no upper bound — a scalability risk, and the opposite failure mode (huge payloads) for dense data.

### B — frontend custom-range window clipped by local timezone (still live)

- `fetchData` builds the window as: `start = new Date(customStart)` (date-only → **UTC** midnight), `end = new Date(customEnd)` then `end.setHours(23,59,59,999)` (**local** end-of-day).
- In a negative-offset zone (e.g. `America/Los_Angeles`), `new Date('2026-06-25')` is the **evening of Jun 24 local**, so `setHours(23,59,...)` lands on the end of **Jun 24**, dropping the entire selected final day. In positive-offset zones the last several hours of the final day are dropped.
- Repro B reproduces this: a reading at 8pm local on the selected end day is excluded from the requested window.

## Recommended fix approach (not implemented here)

1. **Backend `/api/sensors` GET (defect A):**
   - For **bounded** queries (a `startDate`/`endDate` window is supplied — what the data screen always sends), do **not** apply a default row cap; return every row in the window, and keep the existing aggregation so long windows stay cheap. Lower the aggregation/raw threshold so a raw window can never exceed a sane row budget.
   - For **unbounded** queries (no date range — e.g. dashboard `limit=1`), keep an explicit default page size and return correct `total` + `hasMore`.
   - Compute `hasMore` from `offset + returned < total` rather than hardcoding `false`.
   - Update `__tests__/api/sensors.test.ts` to the corrected contract.
2. **Frontend `fetchData` (defect B):** build the window consistently — derive both bounds in the same zone, e.g. `start = new Date(`${customStart}T00:00:00`)` and `end = new Date(`${customEnd}T23:59:59.999`)` (both local), or convert both to UTC explicitly. Then assert window coverage in the repro flips to passing.
3. Add the repro file to CI once fixed (it becomes a regression guard).

## How to run the repro

```
npx jest __tests__/repro/data-range-pagination.repro.test.ts
```

Both suites now **pass** against the current tree.

## Resolution (implemented)

**Backend — `src/app/api/sensors/route.ts` GET (defect A):**
- **Bounded queries** (a `startDate`/`endDate` window — what the data screen always sends)
  are **never** capped to a default page size. If the window fits the raw-row budget
  (`MAX_RAW_ROWS = 5000`, ≈3.5 days at 1 row/min) every row is returned; otherwise the
  server **transparently downsamples** to one averaged point per time bucket spanning the
  *entire* window (`hour` → `6hour` → `day`, auto-chosen to stay ≤ `MAX_AGG_BUCKETS = 750`).
  Either way the full selected range is represented — nothing is silently dropped.
- **Unbounded queries** (no date range, e.g. dashboard `limit=1`) keep an explicit default
  page size (`DEFAULT_UNBOUNDED_LIMIT = 100`) and return correct `total` + `hasMore`.
- `hasMore` is derived from `offset + returned < total` (never hardcoded), so cursor/offset
  paging works. Aggregated responses also carry `pagination` + `aggregation` metadata.
- `limit`, `offset`, `aggregate`, `startDate`, `endDate` are validated (`400` on bad input).
- A one-sided huge range (only `startDate`/`endDate`) can't be bucketed, so it returns a
  raw page capped at `MAX_RAW_ROWS` **with `hasMore: true`** — the client can page; nothing
  is silently lost.

**Frontend — `src/app/data/page.tsx` `fetchData` (defect B + range/pagination consumption):**
- The custom window is built with both bounds in the same (local) zone —
  `new Date(\`${customStart}T00:00:00\`)` and `new Date(\`${customEnd}T23:59:59.999\`)` —
  so the selected final day is fully included.
- `fetchData` now **loads the entire selected window** instead of a single fetch: it
  follows `pagination.hasMore`, paging with `limit=5000&offset=…` until the whole range
  has been pulled (a "load all in range" loop). Aggregated/short responses resolve in one
  page (`hasMore=false`); the rare capped raw page (one-sided huge range) is paged through.
  A `MAX_PAGES` cap + a zero-progress guard make the loop loop-safe.
- A **coverage summary** ("Showing N data points · hourly average · M pages") is rendered so
  the user can confirm the charts/tables reflect the full window, plus a manual **Refresh**
  button and an error banner on failure.

**Tests:** `__tests__/pages/data.test.tsx` pins the frontend contract — single-page render,
multi-page accumulation (`hasMore` paging with correct offset), aggregation labelling,
full custom-window request (incl. the final day), error handling, and the no-infinite-loop
guard.

**Test harness:** API route tests now declare `@jest-environment node` (Next's `Request`/`Response`
globals are absent under jsdom); `jest.setup.js` guards its `window.matchMedia` mock for Node.
