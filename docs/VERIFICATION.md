# OutletHub Verification Report

This report lists the checks that were **actually executed** for the final verification phase, with their real results.

Status legend:

- **PASSED:** executed, all assertions held.
- **FAILED:** executed, with failures.
- **NOT EXECUTED:** not run.
- **BLOCKED:** could not run.

Mocked unit tests are reported as such. They are never counted as real database verification. This document contains no credentials, tokens or passwords.

## Environments used

| Target | What it is | Used for |
| --- | --- | --- |
| **Disposable local PostgreSQL 18.4** | A throwaway cluster created for this verification (`initdb` in a temporary directory, bound to `127.0.0.1:55432`, server time zone `Asia/Dhaka`), with one fresh database per suite (`outlethub_verify_*`), each migrated with the full history | Concurrency, reporting, API, E2E, seed rehearsal and performance |
| **Configured application database** (PostgreSQL 18.7, `TimeZone=UTC`) | The database configured in the backend environment | Migration status, read-only integrity audit, demo seed, demo login checks, one smoke sale |

Every real-database script refuses to run unless all of the following hold:

- the URL is local;
- the database name looks disposable;
- it is not the application database;
- it contains only data the scripts created.

Nothing destructive ran against the configured database. Only additive, `DEMO-`-namespaced records were written there.

## Summary

| Check | Result |
| --- | --- |
| Backend unit tests (`pnpm test`, mocked) | **PASSED:** 479 tests in 25 files |
| Frontend unit tests (`pnpm test`, mocked HTTP) | **PASSED:** 208 tests in 26 files |
| Static checks in both repos (`prisma:generate` backend only, then `lint`, `typecheck`, `format:check`, `build`, `security:audit`) | **PASSED** |
| `pnpm verify:sales-concurrency` (real PostgreSQL) | **PASSED:** 34/34 |
| `pnpm verify:reports` (real PostgreSQL) | **PASSED:** 18/18, and again on a second run against the same database |
| `pnpm verify:api` (real HTTP + real PostgreSQL) | **PASSED:** 75/75, on two consecutive runs |
| Browser E2E (`pnpm test:e2e`, Playwright, real backend + PostgreSQL) | **PASSED:** 4/4 |
| Migration status of the configured database | **PASSED:** 3/3 applied, nothing pending |
| Demo seed on the configured database (`pnpm db:seed:demo`) | see [Demo data](#demo-data-configured-database) |
| Demo staff logins (`pnpm verify:demo-logins`) | see [Demo staff credentials](#demo-staff-credentials) |
| Integrity audit (`pnpm db:audit`) | see [Integrity audit](#integrity-audit-configured-database) |
| Query plans on 100,000 synthetic sales | **PASSED:** every query ≤ 23 ms |
| Sustained load test | **NOT EXECUTED** (out of scope; no throughput claim is made) |

## Defects found and fixed during verification

| # | Defect | How it was found | Fix | Regression test |
| --- | --- | --- | --- | --- |
| 1 | **CORS blocked `PATCH` and `PUT`** (`methods: ['GET','POST']`). Every cross-origin stock adjustment, price or status change, edit and staff-outlet update failed in the browser. | Browser E2E: the stock-adjustment dialog reported an uncertain result | Allow `GET, POST, PATCH, PUT` | `tests/unit/cors.test.ts` (preflight per method, no `DELETE`, untrusted origin refused) |
| 2 | **Date parameters shifted by the server time zone.** `@prisma/adapter-pg` sends `Date` values without an offset, so a non-UTC session moved every date filter and timestamp (sales history, report ranges). The configured database runs in UTC, so it was not affected in practice. | Demo-seed rehearsal on a cluster whose default zone is `Asia/Dhaka`: sale hours came out 6 h early | Pin every pool session to `TimeZone=UTC` (`src/database/client.ts`) | `tests/unit/database.test.ts`, plus a real check in `verify:api` |
| 3 | **Sales-history `to` was inclusive (`lte`)**, unlike the reports' half-open ranges. Adjacent windows double-counted boundary sales. | Review | `created_at < to`, and `to` must be after `from`. OpenAPI and README updated. | `tests/unit/sale-list-range.test.ts`, plus an equal-bounds rejection in `tests/unit/sales.test.ts` |
| 4 | **The POS message mentioned charging** ("retrying never charges twice"), but OutletHub records sales and processes no payments | Review | The wording now says the same request is never recorded twice | `tests/unit/sales/pos.test.tsx` asserts the new text and the absence of "charge" |
| 5 | **Reporting verification used a fixed 2099 window**, so a second run on the same database saw the first run's fixtures | Requirement | Each run picks a random future month and verifies that it is empty first | Executed twice: 18/18 both times |
| 6 | **Demo seed: hour offset applied twice** (sales at 02:00–16:00 instead of 08:00–22:00), and **credentials were only printed at the end** of a run | Seed rehearsal and audit | Correct local-time arithmetic. Each credential is persisted (0600 file) as soon as it is issued. | Rehearsal plus audit: hours 08–22, 0 receipt/time inversions |

## PostgreSQL concurrency scenarios (`verify:sales-concurrency`)

The scenarios run the production `SaleService` and `SaleRepository` against real PostgreSQL. Result: **34/34 checks PASSED.**

| Scenario | Setup | Observed result | Status |
| --- | --- | --- | --- |
| A. Overselling | stock 10, two concurrent sales of 7 | `INSUFFICIENT_STOCK` + `OK`; stock 3; counter 1; 1 sale | PASSED |
| B. Concurrent valid sales | stock 20, ten concurrent sales of 1 | 10 × `OK`; stock 10; receipts 1..10 consecutive | PASSED |
| C. Concurrent idempotency | same request id and payload × 10 | 10 succeeded; 1 created + 9 replays; one sale id; stock 5 → 3; counter 1 | PASSED |
| D. Multi-item atomicity | one line short of stock | `INSUFFICIENT_STOCK`; stock [10, 1] unchanged; counter 0; no sale or lines | PASSED |
| E. Independent outlets | 5 + 5 concurrent sales in two outlets | counters 5 and 5; stock changed per outlet only | PASSED |
| F. Sale vs. stock adjustment | sell 4 while an admin adds 5, from 10 | both committed; final 11 (no lost update) | PASSED |
| G. Sale vs. price change | sell at 100.00 while the base price becomes 120.00 | `PRICE_CHANGED`, stock unchanged (the stale expected price was rejected) | PASSED |
| G2. Sale vs. assignment disable | sell while HQ disables the assignment | `ITEM_UNAVAILABLE`, stock unchanged; a later sale is also refused | PASSED |
| H. Sale vs. membership removal | sell while memberships are replaced with `[]` | `AUTHORIZATION_ERROR`, no sale, membership removed | PASSED |
| H2. Sale vs. staff deactivation | sell while the cashier is deactivated | `AUTHORIZATION_ERROR`, no sale; later sale refused | PASSED |
| I. Real rollback | the real `SaleRepository` on a script-local client proxy whose `saleItem.createMany` throws | stock 10, counter 0, 0 `Sale`, 0 `SaleItem` | PASSED |

For G, G2, H and H2, the race outcome depends on timing. The scripts accept either serial order but require it to be consistent: committed with the old state, or refused with no writes. The run above observed the "refused" branch each time.

## Reporting verification (`verify:reports`)

Fixtures:

- three outlets: busy; inactive with sales; and no sales;
- seven items with quantity ties;
- one item at two prices, and one item renamed after sale;
- sales at `from` (included), at `to` (excluded) and 1 ms before `from` (excluded).

Checks:

- window revenue `339.00`, 4 sales, 26 units;
- current outlet counts;
- an all-time delta of `489.00` over 6 sales;
- zeros for an empty range;
- revenue-by-outlet order, statuses, zero rows, sorting and pagination;
- top-5 ranking with id tie-breaks;
- line-total sums across prices;
- current labels;
- the inactive, no-sales and unknown outlet cases.

**18/18 PASSED, twice**, in windows 6928-11 and 6688-03 on the same database. Each run first verified that its window was empty.

## API integration (`verify:api`)

This drives the real Express app through Supertest on a disposable database, with no mocks. It covers:

- the full HQ → staff → sale → replay → receipt → report workflow;
- invalid and unknown credentials;
- unauthenticated access;
- staff access to five HQ-only endpoints;
- cross-outlet menu, details, sales, inventory and sale creation;
- negative-stock refusal for both adjustments and sales;
- `PRICE_CHANGED` with the current price;
- `IDEMPOTENCY_CONFLICT`;
- inactive outlet, assignment and master item;
- refresh rotation and rotated-token rejection, logout, deactivation (login and existing token);
- exact money values (`984.50`, `1010.25`, normalized overrides);
- a UTC session check.

**75/75 PASSED** on two consecutive runs.

## Browser E2E (`pnpm test:e2e` in the frontend)

Playwright with Chromium 159 (headless shell) runs the real backend (`tsx src/server.ts`) and the Vite dev server against a disposable database. The API is not mocked.

| Test | Result |
| --- | --- |
| Signed-out `/dashboard` redirects to login | PASSED |
| HQ: login, dashboard, then through the UI create an outlet, 2 menu items, assignment, stock, and a staff account with membership | PASSED |
| Staff: login, launcher without reports, POS 2 + 1 cart `৳530.50`, checkout, receipt `…-000001`, history, stock 8/19, `/staff` → Access denied, sign out | PASSED |
| HQ: _Today_ revenue for the outlet `৳530.50`, top item `৳500.00`, sign out, protected route redirects | PASSED |

## Migrations (configured database)

- `pnpm db:migrate:status`: **3 migrations found, database schema is up to date.**
  - `_prisma_migrations` shows `20261125000000_initial_auth`, `20261125100000_business_domain` and `20261126000000_money_not_nan`, all finished and none rolled back.
- The NaN guard `20261126000000_money_not_nan` was **already applied before this phase**; it was not applied in this session.
  - All five constraints exist and are validated: `menu_items_base_price_not_nan`, `outlet_menu_items_override_price_not_nan`, `sales_total_amount_not_nan`, `sale_items_unit_price_not_nan`, `sale_items_line_total_not_nan`.
  - NaN counts in all five money columns: **0**.
- No migration was applied in this phase, so no backup step was needed. The full migration history was also applied cleanly to every fresh disposable database.

## Demo data (configured database)

<!-- demo-results -->

## Demo staff credentials

<!-- login-results -->

## Integrity audit (configured database)

<!-- audit-results -->

## Query plans (disposable database, synthetic data)

- **Dataset:** **100,000 sales, 250,000 sale lines, 10 outlets, 60 items and 600 assignments**, generated with SQL in `outlethub_verify_perf`, then `ANALYZE`d. Timings are from `EXPLAIN (ANALYZE, BUFFERS)` on PostgreSQL 18.4 on the development machine.
- **Scope:** this is a single-query latency measurement. It is not a throughput or load test.

| Query | Plan | Execution time |
| --- | --- | --- |
| Sales history, outlet + 7 days, newest first, page 1 | Index Scan Backward on `sales (outlet_id, created_at)` | 0.095 ms |
| Sales history count (same filter) | Bitmap Index Scan on `(outlet_id, created_at)` | 1.6 ms |
| Sales history by receipt desc, no range, page 200 | Bitmap scan on the outlet + top-N heapsort | 3.1 ms |
| Summary revenue and count, company-wide 30 days | Parallel Seq Scan (the range covers all rows) | 7.9 ms |
| Summary units, company-wide 30 days | Parallel Hash Join `sale_items` ⋈ `sales` | 22.6 ms |
| Summary, company-wide **1 day** | Bitmap Index Scan on `(outlet_id, created_at)` (**skip scan**, 11 index searches) | 1.7 ms |
| Revenue by outlet, 30 days | Parallel Seq Scan + aggregate + LEFT JOIN outlets | 8.9 ms |
| Top five, one outlet, 30 days | Bitmap on `sale_items (outlet_id, menu_item_id)` + hash joins | 8.4 ms |
| Top five, one outlet, 1 day | Bitmap on `sales (outlet_id, created_at)` + `sale_items` index | 1.5 ms |
| Outlet menu / inventory page | Bitmap on `outlet_menu_items` PK | 0.04 ms |

**Conclusion:** the existing indexes serve every hot path at this volume, and PostgreSQL 18's skip scan covers company-wide date filtering without a separate `sales (created_at)` index. No index was added. Full scans for 30-day company-wide windows are expected, because the window selects most rows.

**Remote latency:** from the development machine to the configured database, the measured round trip was ~160 ms (a 10-query transaction took 1.9 s). A sale is about 15–20 round trips, so the API should run close to the database. This latency once pushed a seed transaction past Prisma's 5 s interactive-transaction timeout; the seed resumed safely.

## Known limitations and items not executed

- **Load:** no sustained load or soak test was run, and there is no measured throughput figure. The 100,000-sale figure above is a dataset size for query plans.
- **Disposable database:** the disposable PostgreSQL ran on the developer's machine, not on production-class hardware.
- **Browser coverage:** browser E2E covers the core flows only, in Chromium only.
- **Unexercised failure modes:** the configured database's backup and PITR setup was not inspected (no migration needed it). Network partitions during commit were not simulated against the real database; the client-side recovery flow is covered by mocked frontend tests.
