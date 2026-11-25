# OutletHub Architecture

OutletHub is a multi-outlet point-of-sale and back-office system. HQ administrators manage outlets, staff, the master menu, outlet pricing and stock, and read company reports. Outlet staff sell at the outlets they are assigned to.

This document describes the system **as implemented**. The sections on scaling, microservices and offline POS/KDS are **proposals**, clearly marked, and none of them is implemented.

- Entity-relationship diagram: [`../erd-diagram.pdf`](../erd-diagram.pdf)
- Business workflow flowchart: [`../flowchart-diagram.pdf`](../flowchart-diagram.pdf)
- Executed verification evidence: [`VERIFICATION.md`](VERIFICATION.md)

## 1. System overview

```text
 Browser (React SPA)                      Express API (modular monolith)            PostgreSQL 18
 ───────────────────                      ──────────────────────────────            ─────────────
 React 19 + React Router 8   HTTPS/JSON   /api/v1                                   single database
 TanStack Query (server state) ────────▶  routes → controllers → services          Prisma 7 + adapter-pg
 Zustand (session, cart)     Bearer JWT   → repositories → Prisma / raw SQL ──────▶ constraints, FKs,
 React Hook Form + Zod       + httpOnly   middlewares: request id, pino logs,       row locks, MVCC
                             refresh cookie helmet, CORS allowlist, rate limits
```

| Layer    | Implemented with                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| Frontend | React 19, Vite 8, React Router 8, TanStack Query 5, Zustand, React Hook Form, Zod, shadcn/ui (Radix + Tailwind)             |
| Backend  | Node.js 24, Express 5, TypeScript (strict), Zod validation, pino logging, helmet, express-rate-limit, Swagger UI (optional) |
| Data     | PostgreSQL 18, Prisma 7 with `@prisma/adapter-pg` (node-postgres pool), committed SQL migrations                            |
| Auth     | Argon2id password hashes, short-lived JWT access tokens, rotating opaque refresh tokens in an httpOnly cookie               |

The two applications are deployed independently (static SPA and an API container), so the API runs cross-origin. It uses an exact-origin CORS allowlist with credentials, allowing `GET`, `POST`, `PATCH` and `PUT`.

## 2. Backend structure: a modular monolith

One deployable process, organized by business module under `src/modules/`:

| Module              | Responsibility                                                                         |
| ------------------- | -------------------------------------------------------------------------------------- |
| `auth`              | login, refresh rotation, logout, `/auth/me`, token service                             |
| `access`            | outlet access checks (HQ: outlet exists; staff: active membership of an active outlet) |
| `outlets`           | outlets and their receipt counters                                                     |
| `staff`             | OUTLET_STAFF accounts, status, password reset, outlet memberships                      |
| `menu-items`        | master menu (SKU, name, base price, status)                                            |
| `outlet-menu-items` | per-outlet assignment, override price, assignment status                               |
| `inventory`         | per-outlet stock balances and guarded adjustments                                      |
| `sales`             | POS sales, idempotency, receipts, history                                              |
| `reports`           | revenue summary, revenue by outlet, top-selling items                                  |
| `health`            | liveness and readiness (database ping)                                                 |

Every module follows the same layering:

- **Route:** wires middlewares (`authenticate`, `authorize(role)`, `requireOutletAccess`, `validate({ body, query, params })`) to controller methods.
- **Controller:** HTTP only. It reads validated input and returns the `{ success, message, data }` envelope.
- **Service:** business rules, mapping repository outcomes to typed `AppError`s (409 codes, 404, 403), and bounded retries.
- **Repository:** all database access, including transactions, row locks and parameterized raw SQL where Prisma's query builder is not enough.

Errors use one envelope: `{ success: false, message, code, requestId, errors?: [{ field, message, meta? }] }`. Unexpected errors become a generic 500, logged with the request id.

## 3. Authentication and outlet authorization

- **Passwords** are hashed with Argon2id. Login answers unknown accounts and wrong passwords with the same 401.
- **Access tokens** are JWTs, 15 minutes by default, with issuer and audience checks. `authenticate` reloads the user on every request and rejects inactive accounts, so deactivation takes effect immediately.
- **Refresh tokens** are random opaque values stored only as SHA-256 hashes in `refresh_sessions`, in rotation families:
  - Every refresh rotates the token.
  - Reusing a rotated token revokes the whole family (`REPLAY_DETECTED`).
  - Logout revokes the session.
- **The refresh cookie** is httpOnly, `SameSite=Strict`, `Secure` in production and scoped to `/api/v1/auth`. Login, refresh and logout also require an `Origin` header from the allowlist.
- **Roles** are `HQ_ADMIN` and `OUTLET_STAFF` (`authorize`). Outlet-scoped routes additionally call `OutletAccessService`:
  - **HQ:** may access any existing outlet.
  - **Staff:** need an active membership of an active outlet. Otherwise they get **403**, so the API does not reveal whether an outlet exists.
- **Sales** run as `OUTLET_STAFF` only. Inside the sale transaction the cashier's user row, membership and outlet are locked and re-checked, so a concurrent deactivation or membership removal either happens before the sale (sale refused) or after it.

## 4. Data model

The full diagram is in [`../erd-diagram.pdf`](../erd-diagram.pdf). Key relationships:

- `users` 1—* `outlet_memberships` *—1 `outlets` (composite PK `(user_id, outlet_id)`).
- `outlets` 1—1 `receipt_counters` (PK = `outlet_id`), created in the **same transaction** as the outlet.
- `menu_items` (master; unique `sku`) 1—* `outlet_menu_items` *—1 `outlets` (composite PK `(outlet_id, menu_item_id)`):
  - `override_price` (nullable; effective price = override ?? base);
  - `stock_quantity`;
  - `is_active`.
- `sales` *—1 `outlets` and *—1 `users` (`created_by_id`). Unique constraints:
  - `(outlet_id, receipt_number)` — receipts unique per outlet;
  - `(outlet_id, request_id)` — idempotency;
  - `(id, outlet_id)` — target of the composite FK below.
- `sale_items` (PK `(sale_id, menu_item_id)`) uses two **composite** foreign keys:
  - `(sale_id, outlet_id) → sales(id, outlet_id)`;
  - `(outlet_id, menu_item_id) → outlet_menu_items`.

  Because both share `outlet_id`, a sale line can never reference another outlet's sale or assignment. This is enforced by the database, not just the code.

- Sale lines store **snapshots** (`item_name`, `unit_price`, `line_total`), so receipts never change when the menu does.

### Constraints that protect invariants

| Invariant             | Enforcement                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| No negative stock     | `CHECK (stock_quantity >= 0)`, plus guarded `UPDATE … WHERE stock_quantity >= qty`                                                      |
| Valid money           | `DECIMAL(12,2)` prices and `DECIMAL(16,2)` totals, `CHECK (>= 0)`, and `CHECK (<> 'NaN')` from migration `20261126000000_money_not_nan` |
| Exact line totals     | `CHECK (line_total = unit_price * quantity)`, `CHECK (quantity > 0)`                                                                    |
| Receipt numbers       | `CHECK (receipt_number > 0)` and `UNIQUE (outlet_id, receipt_number)`                                                                   |
| Idempotency           | `UNIQUE (outlet_id, request_id)`, `request_hash` is SHA-256 hex (`CHECK`)                                                               |
| No cross-outlet lines | composite FKs on `sale_items`                                                                                                           |
| Historical integrity  | `ON DELETE RESTRICT` and `ON UPDATE RESTRICT` on sale relations. There are no delete endpoints for business data.                       |

### Important indexes

| Index                                              | Used by                                                                                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sales (outlet_id, created_at)`                    | sales history by outlet and date, per-outlet report ranges. PostgreSQL 18 also skip-scans it for company-wide date ranges (see `VERIFICATION.md`). |
| `sales (outlet_id, receipt_number)` unique         | receipt lookup and ordering by receipt                                                                                                             |
| `sales (outlet_id, request_id)` unique             | idempotency lookup                                                                                                                                 |
| `sale_items (outlet_id, menu_item_id)`             | top-selling items per outlet                                                                                                                       |
| `sale_items` PK `(sale_id, menu_item_id)`          | joining lines to sales                                                                                                                             |
| `outlet_menu_items` PK `(outlet_id, menu_item_id)` | outlet menu and inventory listings, sale locking                                                                                                   |
| `outlet_memberships (outlet_id)`                   | membership checks and staff filters                                                                                                                |

## 5. Transaction boundaries and concurrency

All writes that touch more than one row run in one database transaction. Every transaction takes locks in one **global order**, which rules out deadlock cycles between modules:

```text
users → outlets → receipt_counters → outlet_menu_items (by menu_item_id) → menu_items (by id)
```

### Creating a sale (`SaleRepository.createSale`, READ COMMITTED)

The steps follow the flowchart:

1. Lock the cashier `users` row `FOR SHARE` and re-check that it is active `OUTLET_STAFF` with a membership. Lock the `outlets` row `FOR SHARE` and re-check that it is active.
2. Lock the outlet's `receipt_counters` row `FOR UPDATE`. This serializes sales **per outlet only**; other outlets proceed in parallel.
3. **Idempotency:** look up `(outlet_id, request_id)` after the counter lock, so concurrent duplicates cannot both miss it.
   - Same cashier and same canonical payload hash: return the original sale (**200, replayed**). No stock or receipt is consumed.
   - Otherwise: **409 `IDEMPOTENCY_CONFLICT`**.
4. Lock every line's assignment `FOR UPDATE` in `menu_item_id` order, and master items `FOR SHARE`. Re-check that both are active. Compute effective prices **from the locked rows**, and compare them with the cashier's `expectedUnitPrice`:
   - **409 `ITEM_UNAVAILABLE`**, **`PRICE_CHANGED`** or **`INSUFFICIENT_STOCK`**, with per-item `meta`.
5. Calculate money in BigInt minor units: exact, with a total limit.
6. Deduct stock with guarded updates, increment the counter, insert the `Sale` and its `SaleItem` snapshots, then commit. Any failure rolls back everything, including stock and the receipt number.

The service retries serialization or deadlock (`P2034`) and unique-race (`P2002`) failures up to 3 times. Ambiguous failures (for example, a connection lost during commit) are **not** retried server-side. The client resolves them with the same request id (`GET /sales/by-request/:requestId` or a replay).

**Receipts** are gap-free per outlet. The number is consumed only inside a committed transaction, because the counter row is locked and incremented in the same transaction as the sale.

**Stock adjustments** use the same assignment row lock. A `SET` adjustment carries `expectedStockQuantity`, which acts as optimistic concurrency against a stale screen.

### Client-side idempotency (frontend)

1. The POS generates a request UUID per logical sale and freezes the payload.
2. It saves the payload to `sessionStorage` **before** the POST. If storage fails, nothing is sent.
3. Unresolved failures keep the same id for "Check status" and "Retry same sale".
4. Only conclusive pre-commit rejections release the cart for correction under a new id.

## 6. Reporting

Reports (`src/modules/reports`) are HQ-only aggregate queries:

- **Snapshot:** each endpoint's queries run in **one REPEATABLE READ snapshot** with no row locks, so reads never block cashiers.
- **Summary:** revenue and count come from `sales`; units come from a separate `sale_items ⋈ sales` sum. Keeping them separate means there is no join multiplication.
- **Revenue by outlet:** `outlets LEFT JOIN` a date-filtered aggregate subquery. Inactive and zero-sale outlets are included. Sorting uses allowlisted fragments in PostgreSQL.
- **Top selling:** grouped by `menu_item_id`, `ORDER BY SUM(quantity) DESC, menu_item_id`, `LIMIT 5`, with current master labels.
- **Dates:** half-open `[from, to)` ISO instants with offsets, at most 366 days. Sales history uses the same convention.
- **Money:** aggregated in `NUMERIC`, returned as exact 2-decimal strings with no upper bound. Counts are integer strings.

Every database session is pinned to `TimeZone=UTC` (`src/database/client.ts`). The node-postgres adapter sends `Date` parameters without an offset, so a non-UTC server or role setting would otherwise shift every date filter and timestamp. This was found during real-database verification and fixed with a regression test.

## 7. Frontend architecture

- **Structure:** feature folders (`src/features/<feature>/{components,hooks,schemas,services,stores,types,utils}`), with pages in `src/pages`.
- **Routing:** one route table with lazy routes, `ProtectedRoute`, `PublicRoute` and `RoleGuard`. The guards are UX only; the API is authoritative.
- **Server state:** TanStack Query with query-key factories per feature. Mutations invalidate exactly the affected keys. A completed sale updates that outlet's sales, menu, inventory **and all report queries**. The whole cache is cleared when a session ends.
- **Client state:** Zustand.
  - The session lives in memory only, with refresh via the httpOnly cookie and coordinated single-flight refresh.
  - The POS cart is keyed by `userId:outletId` and wiped on session change.
- **Validation:** API responses are parsed with Zod before use. Money is handled as exact strings and BigInt cents, never floats.
- **Dashboard:** role-aware. HQ gets reports with local-calendar date presets in the URL; staff get a launcher for their outlets.

## 8. Operations (current)

- **Health:** `/api/v1/health/live` and `/api/v1/health/ready` (the latter checks the database with a timeout).
- **Logging:** structured pino logs with request ids. Secrets and authorization headers are redacted.
- **Security middleware:** helmet; global and authentication-specific rate limits; body size limit; request timeout; trusted origin checks on cookie endpoints.
- **Shutdown and config:** graceful shutdown. Configuration comes from environment variables validated at start-up, which fails fast.

---

## 9. Scaling plan: 10 outlets and 100,000 transactions per month (proposal)

**Current state.** One API instance and one PostgreSQL database. 100,000 sales per month is about 3,300 per day, or about 0.04 per second on average. An evening peak of about 10× average is still under one sale per second across the company, and per outlet it is far lower.

**What was measured.**

- On a synthetic dataset of **100,000 sales / 250,000 sale lines / 10 outlets** in a disposable local PostgreSQL 18, every reporting and listing query ran in **≤ 23 ms** (see `VERIFICATION.md`).
- Against the remote configured database, a sale transaction costs about 15–20 round trips. At the measured ~160 ms round-trip time from a remote client, that is roughly 3 s. Colocating the API with the database, as in the intended deployment, removes almost all of that.
- No sustained load test was run, so no throughput figure is claimed.

### Database

- **Connection pooling.**
  - Each API instance has a bounded pool (`DATABASE_POOL_MAX`, default 10).
  - Keep `instances × pool ≤ max_connections − headroom`.
  - Add PgBouncer in transaction mode only if instance count grows. Interactive transactions are compatible with transaction pooling, but session-level settings are not, so the UTC time-zone pin would then move to the database or role level.
- **Indexes and plans.** The current indexes cover every hot path (measured). Re-check plans with `EXPLAIN (ANALYZE, BUFFERS)` on a production-sized copy as data grows. `pg_stat_statements` is the tool for finding real slow queries.
  - The next candidate is a `sales (created_at)` index, but only if company-wide range reports become slow. At 100k rows, PostgreSQL 18 skip-scans the existing composite index in under 2 ms for a 1-day range.
- **Vertical scaling** first: more CPU and RAM, with a `shared_buffers`/`work_mem` review. 100k sales per month is well within a single modest instance.
- **Read replicas** only when report load measurably affects POS latency. Replicas introduce replication lag, so reports would need to state "as of" a time.
- **Backup and recovery.** Use continuous WAL archiving with point-in-time recovery, plus daily base backups and tested restores. Snapshots alone are not enough for a sales ledger.
- **Receipt-counter contention.**
  - The counter lock is per outlet and held only for the length of a sale transaction, so it caps throughput **per outlet**. At about 50–100 ms of in-region transaction time, that is roughly 10–20 sales per second per outlet, far above any till.
  - If one outlet ever needed more, use per-terminal receipt series (`outlet + terminal + number`). Note that this changes the gap-free-per-outlet guarantee.
- **Partitioning** (`sales` and `sale_items` by month) is only worth its complexity at tens of millions of rows, or for archival. 1.2M sales per year does not require it.

### Reporting performance

- **Today:** aggregation happens in the database, index-assisted ranges are used, and every endpoint reads one consistent snapshot without locks.
- **When a range gets slow:** add daily per-outlet summaries (`sales_daily(outlet_id, day, revenue, sale_count, units)` plus per-item daily rows). Keep them current either way:
  - updated in the sale transaction (strictly consistent, slightly longer write path); or
  - refreshed asynchronously (eventually consistent, labelled "as of").

  A materialized view refreshed concurrently is the simplest asynchronous option.

- **Isolating report load:** move reports to a replica, or schedule heavy exports off-peak, before touching the write path.

### Infrastructure

- **Statelessness:** the API is stateless, since sessions live in PostgreSQL and tokens are stateless. Run several instances behind a load balancer that uses `/health/ready` for readiness and `/health/live` for liveness.
- **Rate limiting:** current limits are in-memory per instance. With multiple instances, move them to a shared store or the edge.
- **Monitoring and alerting:**
  - request latency, 4xx and 5xx rates by route, and `INSUFFICIENT_STOCK`/`PRICE_CHANGED`/`CONCURRENT_UPDATE` rates;
  - database connections, lock waits, slow queries and replication lag;
  - disk and WAL growth.
- **Logs:** ship the structured pino JSON logs with request ids to a central store.

### Architectural evolution

The modular monolith fits this size:

- Sale, stock and receipt need one ACID transaction.
- The team and traffic are small.
- One deployable keeps operations simple.

Expected first bottlenecks, in order:

1. network latency between the API and the database;
2. report queries over long ranges;
3. the connection count as instances grow.

Measure them with route latency percentiles, `pg_stat_statements`, lock-wait monitoring and pool saturation metrics. Add infrastructure only when a metric crosses an agreed threshold (for example, POS p95 above 300 ms, or report p95 above 2 s).

## 10. Microservices evolution (proposal)

Possible bounded contexts:

| Context                 | Owns                                              | Notes                                                              |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| Identity & Access       | users, credentials, sessions, roles, memberships  | Issues tokens; other services verify JWTs locally                  |
| Outlet Management       | outlets, outlet status                            | Publishes `OutletActivated` and `OutletDeactivated`                |
| Menu & Pricing          | master items, outlet assignments, override prices | Publishes price and availability changes                           |
| Sales & Inventory       | sales, sale lines, stock, receipt counters        | **One service, one database:** sale, stock and receipt stay atomic |
| Reporting               | read models (daily outlet and item aggregates)    | Built from events; eventually consistent                           |
| Notifications / Kitchen | KDS tickets, alerts                               | Consumes `SaleCompleted`                                           |

- **Database ownership:** each service owns its schema, and no service reads another's tables.
- **Communication:** synchronous HTTP or gRPC for queries that need current data, such as a price check, with timeouts and circuit breakers. Asynchronous events for everything else.
- **Transactional outbox:** a service writes its business change and an `outbox` row in the same transaction. A relay publishes outbox rows to the broker and marks them sent. This avoids the dual-write problem, where a commit succeeds but the publish is lost.
- **Idempotent consumers:** each event has a unique id, and consumers record processed ids (an `inbox` table) in the same transaction as their own change. Delivery is at-least-once, but the effect happens once.
- **Event-driven reporting:** Reporting consumes `SaleCompleted` (lines, totals, outlet, timestamp) and maintains aggregates. Dashboards show "as of" the last processed event, and a replay can rebuild them.
- **Eventual consistency:**
  - Menu and pricing changes reach Sales asynchronously. Sales must then validate against its own replicated copy, and the `PRICE_CHANGED` contract still protects the cashier.
  - Outlet deactivation reaches Sales as an event. The small window between the event and its delivery must be acceptable.
- **Failure recovery:** retries with backoff, dead-letter queues, replay from the outbox or broker, and reconciliation jobs (for example, comparing Reporting totals with Sales).
- **Observability:** distributed tracing (OpenTelemetry) with propagated correlation ids, plus per-service SLOs and consumer-lag monitoring.

**Why sales, stock and receipts must stay together.** Today one transaction guarantees all of the following:

- no oversell;
- gap-free per-outlet receipt numbers;
- an idempotent replay that never deducts twice;
- all-or-nothing rollback.

Splitting stock or receipts into another service would replace that with a saga: reserve stock, then confirm or compensate. That brings new failure modes (orphaned reservations, receipt gaps after compensation, double-deduction on retries) and needs distributed idempotency everywhere. There is no current requirement that justifies it, so Sales & Inventory should remain one service with one database until a measured need and a reviewed distributed-consistency design exist.

## 11. Offline POS and KDS strategy (proposal, not implemented)

**Goal:** keep selling and cooking during an internet outage, then reconcile with HQ.

### Local data at each terminal

- **Catalog snapshot:** the outlet menu (assigned, active items with effective prices) and a stock snapshot, refreshed whenever online and stamped with a version and time.
- **Durable order store:** IndexedDB in the browser, or SQLite in a packaged app. Each order is written **before** it is acknowledged on screen.
- **Ids:** every sale gets a client-generated UUID, which is the existing `requestId`. Because the server already deduplicates on `(outlet_id, request_id)`, synchronization is naturally idempotent.

### Synchronization

1. **Queue:** orders move through `pending → sending → synced | rejected | needs_review`.
2. **Retry:** retry with exponential backoff and jitter when connectivity returns, and send in creation order per terminal.
3. **Outcome:**
   - **201 or 200 (replay):** mark synced and store the server receipt and totals.
   - **409 (`PRICE_CHANGED`, `INSUFFICIENT_STOCK`, `ITEM_UNAVAILABLE`):** these are conflicts with HQ state. The sale already happened physically, so an offline sale needs a separate endpoint, for example `POST /sales/offline`, that records it with a `recorded_offline_at` time and its local prices. That endpoint would accept negative-availability **exceptions** for review instead of rejecting them, which requires a new, explicitly designed contract. Today's online endpoint intentionally rejects such sales.
4. **Status:** show synchronization status per order and per terminal ("12 pending, last sync 10:42"), with acknowledgments from HQ.

### Prices, stock and multiple terminals

- **Stale prices:** sell at the snapshot price and record the snapshot version. HQ accepts the offline price as the historical price, and reporting flags the sale as offline-priced.
- **Stock while offline:** stock cannot be guaranteed across disconnected terminals. Options:
  1. **Per-terminal allocation:** split the stock snapshot between terminals. This is safe, but a terminal can run out while another has stock.
  2. **An outlet-local coordinator:** a small service on the outlet LAN, such as a mini-PC, that owns local stock and the order sequence for all terminals. This is the recommended option for multi-terminal outlets.
  3. **Accept oversell risk:** flag negative balances for review on sync.

### Receipt numbering

**Strict gap-free per-outlet numbering cannot be guaranteed across disconnected, independent terminals without coordination.** The options are:

| Option                                                                                            | Trade-off                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Provisional local receipt** (`MIRPUR-T2-OFF-000045`), with the official number assigned at sync | Customers hold a provisional number. The official sequence is gap-free, but its order is sync order, not sale order.      |
| **Reserved ranges** per terminal (HQ hands out ranges such as 5001–5500 while online)             | Numbers are final at sale time. Gaps appear when a range is not used up, and order is not chronological across terminals. |
| **Outlet-local coordinator** numbering                                                            | Gap-free within the outlet while the LAN is up. It needs reconciliation if the coordinator itself fails over.             |

### Kitchen display (KDS) offline

- **Local publication:** the POS publishes each order to the outlet-local service (the coordinator above) over the LAN, using WebSocket or MQTT. It does not need the internet.
- **Order messages:** each one carries the order UUID, lines, notes and a sequence number. The KDS **acknowledges** receipt, and the POS shows "sent to kitchen" only after the acknowledgment arrives.
- **Duplicate prevention:** the KDS deduplicates by order UUID, so resending after a timeout is safe.
- **Status transitions:** `received → preparing → ready → served` (and `cancelled`). Every transition is persisted locally with a timestamp and broadcast to the POS terminals.
- **Restarts:** the coordinator and the KDS persist their queues (SQLite). After a restart, the KDS replays unacknowledged orders and current statuses from the coordinator.
- **HQ sync:** once the internet returns, the coordinator forwards sales through the idempotent sync above, and optionally sends kitchen timing data for reporting.

None of this is implemented. The current POS requires connectivity and shows an explicit recovery flow for uncertain submissions.
