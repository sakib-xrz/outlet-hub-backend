# OutletHub Backend

Production-oriented backend for OutletHub, a multi-outlet POS management system. It contains the platform infrastructure, authentication and session management, health checks, **Outlet Management** (phase 1), **Staff & Outlet Membership Management** (phase 2) and **Master Menu Management** (phase 3). Outlet menu assignment, inventory, sales, receipt and reporting features are not implemented yet; their tables exist in the schema for later phases.

## Stack

- Node.js 24 LTS, Express 5, strict TypeScript, pnpm
- External PostgreSQL (Coolify-managed), Prisma ORM 7 with the `pg` driver adapter
- Zod configuration/request validation
- Argon2id passwords, HS256 JWT access tokens, opaque rotating refresh tokens
- Pino structured logging, Helmet, strict CORS/origin checks, layered rate limits
- OpenAPI 3 and development-only Swagger UI
- Vitest, Supertest, ESLint, Prettier, Husky, lint-staged, Commitlint (Conventional Commits)
- Multi-stage Dockerfile and an application-only Docker Compose file, deployed via Coolify

## Architecture

The codebase is a feature-based modular monolith with explicit layers:

```text
src/
├── common/                 # framework-neutral errors, types, and utilities
├── config/                 # env-file loading, validated configuration, logging
├── database/               # Prisma client factory and connection pool
├── docs/                   # implemented-endpoint OpenAPI contract
├── generated/prisma/       # generated; ignored and recreated during install/build
├── middlewares/            # HTTP cross-cutting concerns
├── modules/
│   ├── access/             # outlet-access checks (membership, HQ scope)
│   ├── auth/               # routes → controller → service → repository
│   ├── health/             # liveness and readiness
│   ├── menu-items/         # master menu (HQ only)
│   ├── outlets/            # outlet management
│   └── staff/              # staff accounts and outlet memberships
├── routes/                 # versioned route composition
├── app.ts                  # side-effect-free Express factory
└── server.ts               # process and server lifecycle
prisma/
├── migrations/             # immutable SQL migration history
├── schema.prisma           # full domain schema (later phases use more of it)
└── seed.ts                 # explicitly invoked HQ administrator seed
tests/unit/                 # database-independent unit tests
```

Controllers only translate HTTP input/output. Services own authentication orchestration without Express types. Repositories own Prisma access and transactional refresh rotation. Prisma's interactive transaction client is used internally with `Serializable` isolation.

## Shared database (intentional, assessment only)

There are no real users, so **local development and production intentionally connect to the same Coolify-managed PostgreSQL database**. No database runs in Docker, and there is no separate test database.

Consequences to keep in mind:

- Every local action (logins, refresh-session rows, seeds, migrations) changes production data immediately.
- A migration applied from a laptop is applied to production. A bad migration breaks production.
- Developer machines hold production credentials; a leaked `.env.development` is a production breach.
- Local and deployed instances share the connection limit; keep `DATABASE_POOL_MAX` small on both.
- Never run `prisma migrate dev`, `migrate reset`, or `db push` here. They can drop data. That is why `migrate dev` has no script.

For a real product, use separate databases per environment, least-privilege roles (a runtime role without DDL rights, a separate migration role), and backups with tested restores.

## Environments

Only two deployment environments exist: `development` and `production`.

| File               | Purpose                                                           | Committed |
| ------------------ | ----------------------------------------------------------------- | --------- |
| `.env.example`     | Template documenting every variable                               | Yes       |
| `.env.development` | Local `pnpm dev`, Prisma CLI, and seed commands                   | **No**    |
| `.env.production`  | Local production runs (`NODE_ENV=production pnpm start`, Compose) | **No**    |

Loading rules (`src/config/load-env.ts`, imported first by the server, seed, and `prisma.config.ts`):

1. `NODE_ENV` defaults to `development`. The matching `.env.<NODE_ENV>` is loaded if it exists.
2. Variables already in the process environment always win. On Coolify, injected variables are authoritative. The image contains no env files.
3. Under the test runner (`NODE_ENV=test`, set by Vitest), no file is loaded. Vitest also overrides `DATABASE_URL` with an unroutable placeholder, so tests cannot reach the shared database. `test` is not an accepted application environment.

All configuration is validated by Zod before startup. Invalid or unsafe combinations stop the process.

| Variable                                             | Purpose                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `NODE_ENV`                                           | `development` or `production`                                     |
| `PORT`                                               | Listener port (default `3000`); the server always binds `0.0.0.0` |
| `TRUST_PROXY`                                        | Number of trusted reverse proxies (`1` behind Coolify's proxy)    |
| `REQUEST_TIMEOUT_MS`, `SHUTDOWN_TIMEOUT_MS`          | Request and bounded drain timeouts                                |
| `BODY_LIMIT`                                         | JSON/form request size, such as `100kb`                           |
| `DATABASE_URL`                                       | `postgres://` or `postgresql://` URL; optional `?schema=`         |
| `DATABASE_POOL_MAX`                                  | Max pooled connections per instance (default `10`)                |
| `DATABASE_CONNECTION_TIMEOUT_MS`                     | Connection acquisition timeout                                    |
| `DATABASE_IDLE_TIMEOUT_MS`                           | Idle pooled-connection lifetime                                   |
| `DATABASE_HEALTH_TIMEOUT_MS`                         | Readiness query deadline                                          |
| `JWT_SECRET`                                         | ≥ 32 random characters; placeholders rejected in production       |
| `JWT_ISSUER`, `JWT_AUDIENCE`                         | Token trust boundaries                                            |
| `JWT_ACCESS_TTL_SECONDS`                             | Access-token lifetime (60–3600 s)                                 |
| `REFRESH_TOKEN_TTL_SECONDS`                          | Refresh-session lifetime                                          |
| `REFRESH_COOKIE_NAME`                                | HttpOnly cookie name                                              |
| `COOKIE_SECURE`, `COOKIE_SAME_SITE`, `COOKIE_DOMAIN` | Cookie policy; production requires `COOKIE_SECURE=true`           |
| `ALLOWED_ORIGINS`                                    | Comma-separated exact browser origins; no wildcards or paths      |
| `*_RATE_LIMIT_*`                                     | Global and authentication limiter windows and limits              |
| `LOG_LEVEL`, `LOG_PRETTY`                            | Log level; pretty printing (development only)                     |
| `SWAGGER_ENABLED`                                    | Enables Swagger UI outside production only                        |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`                      | Read only by the explicit admin seed command                      |

Never commit real env files. If a secret is exposed, rotate it. Removing it from Git history is not enough.

## Local development

Requirements: Node.js 24 LTS and pnpm 12. No local PostgreSQL or Docker is needed.

```bash
pnpm install --frozen-lockfile
cp .env.example .env.development   # fill in DATABASE_URL, JWT_SECRET, …
pnpm prisma:generate
pnpm db:migrate:status               # read-only check against the shared database
pnpm dev
```

The API listens on `http://localhost:3000`. Swagger UI is at `/docs` when `SWAGGER_ENABLED=true` outside production. The OpenAPI document is at `/openapi.json`.

### Connecting securely to the Coolify PostgreSQL

SSL is configured only through standard `DATABASE_URL` parameters (`sslmode`, `sslrootcert`). Both the API (node-postgres) and the Prisma CLI read them.

**Option A: SSH tunnel (recommended).** The database port is never exposed to the internet.

```bash
# On the VPS, find the database container's IP on the Coolify network:
#   docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <db-container>
ssh -N -L 127.0.0.1:55432:<db-container-ip>:5432 <user>@<vps-host>
```

```dotenv
DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:55432/<db>?schema=public
```

**Option B: public port with TLS.** In Coolify, enable **SSL** on the database and **Make it publicly available** on a non-default port. Restrict that port to your IP in the Hostinger VPS firewall. Docker-published ports bypass `ufw`. Then copy Coolify's CA certificate from the server (`/data/coolify/ssl/coolify-ca.crt`) to your machine:

```dotenv
DATABASE_URL=postgresql://<user>:<password>@<vps-ip>:<public-port>/<db>?schema=public&sslmode=require&sslrootcert=/absolute/path/to/coolify-ca.crt
```

Use an absolute `sslrootcert` path. node-postgres treats `sslmode=require` as `verify-full`, so the certificate must match the host you connect to. If you connect by IP and the certificate does not include it, add `uselibpqcompat=true`. The CA is still verified, but the hostname is not. Option A avoids this entirely.

## Database migrations and seed

The schema is managed only through committed SQL migrations in `prisma/migrations/`. Nothing runs migrations or seeds automatically: not app startup, not the Docker build, not tests.

| Migration                        | Contents                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `20261125000000_initial_auth`    | Users and refresh sessions                                                                                                  |
| `20261125100000_business_domain` | Outlets, memberships, menu items, outlet stock/pricing, receipt counters, sales, sale items, and database CHECK constraints |
| `20261126000000_money_not_nan`   | **Pending, not applied.** Additive `<> 'NaN'` checks on every money column                                                  |

The CHECK constraints are added in SQL because Prisma cannot express them:

- stock is never negative;
- sale quantities are positive;
- base, override and unit prices and sale totals are non-negative;
- `line_total = unit_price × quantity`;
- receipt numbers are positive and counters non-negative;
- `request_hash` is a SHA-256 hex string;
- codes, SKUs and names are not blank.

Checks that span rows, such as a sale total equalling the sum of its lines, belong in the sale service's transaction.

1. Edit `prisma/schema.prisma`.
2. Generate SQL without writing to the database. `migrate diff` is read-only:

   ```bash
   mkdir -p prisma/migrations/$(date -u +%Y%m%d%H%M%S)_descriptive_change
   pnpm -s db:migrate:diff > prisma/migrations/<that-folder>/migration.sql
   ```

3. Review the SQL. Prefer additive, backward-compatible (expand/contract) changes.
4. Take a database backup (Coolify → database → Backups).
5. Apply it deliberately:

   ```bash
   pnpm db:migrate:status
   pnpm db:migrate:deploy                                  # from your machine, or
   docker compose --profile migrate run --rm migrate       # from the migration image
   ```

Create or rotate the HQ administrator explicitly:

```bash
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='long-unique-secret' pnpm db:seed:admin
```

The seed is idempotent for the normalized email and intentionally resets that account's password and role. It never logs the password.

## Authentication API

Base path: `/api/v1`.

| Method | Path            | Authentication                    | Purpose                                  |
| ------ | --------------- | --------------------------------- | ---------------------------------------- |
| `POST` | `/auth/login`   | Trusted `Origin` + credentials    | Issue access token and refresh cookie    |
| `POST` | `/auth/refresh` | Trusted `Origin` + refresh cookie | Atomically rotate the refresh session    |
| `POST` | `/auth/logout`  | Trusted `Origin` + refresh cookie | Revoke session and clear cookie          |
| `GET`  | `/auth/me`      | `Authorization: Bearer …`         | Return the active user identity          |
| `GET`  | `/health/live`  | None                              | Process liveness; no database dependency |
| `GET`  | `/health/ready` | None                              | Timed PostgreSQL readiness query         |

Login responses include `{ accessToken, tokenType, expiresIn, user }`. Store the access token only in frontend memory and send it as a Bearer token. Browsers must send credentials for refresh/logout, for example `fetch(url, { credentials: 'include', headers: { Origin: location.origin } })`; browsers set `Origin` themselves. The refresh cookie is HttpOnly, path-scoped to `/api/v1/auth`, SameSite-controlled, and Secure in production.

Access tokens enforce the explicit HS256 algorithm, issuer, audience, expiry, and role claims. Refresh tokens contain 256 bits of randomness; only SHA-256 hashes are persisted. Every use rotates the token in a serializable transaction. Reuse of a rotated token revokes all still-active sessions in that token family, including the result of a concurrent refresh. Logout is idempotent. Authentication errors remain generic to limit account enumeration.

Roles are `HQ_ADMIN` and `OUTLET_STAFF`.

- `authenticate` verifies the JWT, then loads the user from the database on every request. A deactivated user is rejected immediately, and the role always comes from the database, never from a possibly stale token claim.
- `authorize(...roles)` restricts routes by role.
- `requireOutletAccess(access, 'outletId')` validates the outlet id in the route and calls `OutletAccessService.assertCanAccessOutlet`:
  - HQ admins may access any existing outlet. A missing outlet returns 404.
  - Outlet staff need a membership in an **active** outlet; otherwise they get 403, which does not reveal whether the outlet exists.
- Business services should repeat this check with their transaction client (`assertCanAccessOutlet(user, outletId, tx)`), so access is checked atomically with the write.

Success responses follow:

```json
{ "success": true, "message": "Operation successful", "data": {} }
```

Errors follow:

```json
{
  "success": false,
  "message": "Validation failed",
  "code": "VALIDATION_ERROR",
  "requestId": "...",
  "errors": []
}
```

## Outlets API

All endpoints are under `/api/v1/outlets`, require `Authorization: Bearer <token>`, and use the standard response envelope. Full schemas are in `/openapi.json` and in Swagger UI (development only).

| Method  | Path                        | Access                                     | Result                                       |
| ------- | --------------------------- | ------------------------------------------ | -------------------------------------------- |
| `GET`   | `/outlets`                  | Any authenticated user (scoped)            | `{ items, pagination }`                      |
| `GET`   | `/outlets/:outletId`        | HQ admin; staff with access to that outlet | `{ outlet }`                                 |
| `POST`  | `/outlets`                  | `HQ_ADMIN`                                 | `201 { outlet }`; `409` on duplicate code    |
| `PATCH` | `/outlets/:outletId`        | `HQ_ADMIN`                                 | `{ outlet }`; name and/or address only       |
| `PATCH` | `/outlets/:outletId/status` | `HQ_ADMIN`                                 | `{ outlet }`; body `{ "isActive": boolean }` |

**Outlet fields:** `id`, `code`, `name`, `address` (nullable), `isActive`, `createdAt`, `updatedAt`.

**Listing:**

| Parameter   | Values                                                       | Default     |
| ----------- | ------------------------------------------------------------ | ----------- |
| `page`      | integer ≥ 1                                                  | `1`         |
| `limit`     | 1–100                                                        | `20`        |
| `search`    | up to 100 characters; matches code or name, case-insensitive | none        |
| `status`    | `all`, `active`, `inactive`                                  | `all`       |
| `sortBy`    | `code`, `name`, `createdAt`, `updatedAt`                     | `createdAt` |
| `sortOrder` | `asc`, `desc`                                                | `desc`      |

- `pagination` is `{ page, limit, total, totalPages }`.
- Results are always ordered by `id` as a tie-breaker, so pages don't overlap or skip rows.
- Unknown or repeated query parameters return 400.

**Authorization:**

- HQ admins can list and read every outlet, including inactive ones.
- Staff can list and read only **active** outlets they are members of. The restriction is part of the database query for both the page and the total count; nothing is filtered in memory.
- A staff member reading any other outlet gets 403. An HQ admin reading a missing outlet gets 404.
- Create, update and status changes are `HQ_ADMIN` only, enforced by `authorize` on the route. The frontend's hidden buttons are UX only.
- `authenticate` re-checks on every request that the user is active and has the given role, so a deactivation or role change applies immediately.

**Validation and normalization:**

- **Code:** trimmed and uppercased. 2–20 characters of letters, digits and single hyphens (no leading, trailing or double hyphens).
- **Name:** trimmed, 1–150 characters.
- **Address:** trimmed, up to 500 characters. An empty string or `null` clears it.
- **Bodies are strict.** `id`, `code` (on update), `isActive` (on update), timestamps and receipt fields are rejected rather than ignored, which prevents mass assignment.
- **Update** needs at least one of `name` or `address`.
- **Status** accepts only a JSON boolean.

**Creation transaction:**

- `POST /outlets` creates the outlet and its `ReceiptCounter` (`lastNumber = 0`) in one interactive Prisma transaction. If the counter insert fails, the outlet insert is rolled back.
- The database unique index on `outlets.code` is the authority. A duplicate code, including two concurrent creations, raises Prisma `P2002`, which returns `409 CONFLICT` with `errors: [{ field: "body.code" }]`.

**Codes are immutable.** No endpoint accepts `code` after creation. This keeps receipt and reporting references stable.

**Activation and deactivation:**

- The status endpoint only flips `is_active`.
- Memberships, outlet menu items and stock, sales, sale items and the receipt counter are never deleted or reset.
- Repeating the current status returns the outlet unchanged; `updatedAt` is not bumped.
- There is no hard delete.
- Because staff access checks query `outlet.is_active` on every request, a deactivated outlet is excluded from staff access immediately.

**Rules for future sales and inventory modules:**

- Run `OutletAccessService.assertCanAccessOutlet(user, outletId, tx)` inside the business transaction.
- Re-read the outlet row with a row lock in the same transaction (`SELECT … FROM outlets WHERE id = $1 FOR SHARE`), and reject the operation if `is_active` is false.
- A shared lock blocks a concurrent deactivation until the sale commits, and any sale that starts after the deactivation sees `is_active = false`.
- A transaction-scoped check alone does not close every race; it is this lock that serializes the sale against the status change.
- The status endpoint currently uses a plain `UPDATE`, which takes a row lock and therefore waits for sales holding `FOR SHARE`.

**Testing:**

- `tests/unit/outlets.test.ts` covers HTTP behavior: validation, normalization, roles, staff scope, 400/401/403/404/409, and idempotent status changes.
- `tests/unit/outlet-repository.test.ts` covers query shape and the creation transaction.
- These tests use mocked stores and a fake Prisma client. They verify the _orchestration_ (same transaction client, failures propagate), not real PostgreSQL atomicity. That is covered by the manual check below.

### Manual database check (run only with approval; it writes to the shared database)

1. Start the API and sign in as an HQ admin to get an access token.
2. `POST /outlets {"code":" smoke-01 ","name":"Smoke"}` → 201 with code `SMOKE-01`. Then run `SELECT last_number FROM receipt_counters WHERE outlet_id = '<id>'` and confirm it is `0`.
3. Send the same `POST` twice in parallel. One returns 201 and the other 409.
4. `PATCH /outlets/<id>/status {"isActive":false}`, then repeat it. Both return 200 with `isActive: false`, and `updated_at` changes only once.
5. Sign in as a staff user who has a membership row for the outlet. `GET /outlets/<id>` returns 403 while the outlet is inactive and 200 after reactivation. `GET /outlets` shows the outlet only while it is active.
6. `PATCH /outlets/<id> {"code":"X-1"}` returns 400, and the code is unchanged.
7. Optional rollback check, only on a throwaway database: drop the counter table's write permission for the API role (`REVOKE INSERT ON receipt_counters FROM <role>`). `POST /outlets` should then return 500 with no new row in `outlets`. Restore the permission afterwards.

## Staff API

All endpoints are under `/api/v1/staff`. Every endpoint requires a bearer token and the `HQ_ADMIN` role. They only ever read or change `OUTLET_STAFF` accounts: an HQ administrator's id returns 404, exactly like a missing account.

| Method  | Path                       | Body                              | Result                                    |
| ------- | -------------------------- | --------------------------------- | ----------------------------------------- |
| `GET`   | `/staff`                   | –                                 | `{ items, pagination }`                   |
| `GET`   | `/staff/:staffId`          | –                                 | `{ staff }` with assigned outlets         |
| `POST`  | `/staff`                   | `{ email, password, outletIds? }` | `201 { staff }`; `409` on duplicate email |
| `PATCH` | `/staff/:staffId`          | `{ email }`                       | `{ staff }`                               |
| `PATCH` | `/staff/:staffId/status`   | `{ isActive }`                    | `{ staff }`                               |
| `PUT`   | `/staff/:staffId/outlets`  | `{ outletIds }` (complete set)    | `{ staff }`                               |
| `PATCH` | `/staff/:staffId/password` | `{ newPassword }`                 | `{}`; rate limited per administrator      |

**Responses:**

- Staff identity is `id`, `email`, `role` (always `OUTLET_STAFF`), `isActive`, `createdAt` and `updatedAt`.
- List items add `outletCount`, which comes from a Prisma `_count` in the same query, so there is no N+1.
- Details add `outlets: [{ id, code, name, isActive }]`, ordered by code and including inactive outlets.
- Password hashes, sessions and passwords are never returned.

**Listing:**

- Same `page`/`limit` contract as outlets (default 20, max 100).
- `search` is a case-insensitive email match, up to 100 characters.
- `status` is `all`, `active` or `inactive`.
- `outletId` (a UUID) returns only staff assigned to that outlet.
- `sortBy` is `email`, `createdAt` or `updatedAt`; `sortOrder` is `asc` or `desc`; `id` is the tie-breaker.
- All filters, and the count, are applied in the database query.

**Validation:**

- **Email:** trimmed and lowercased, at most 320 characters. Uniqueness is enforced by the database's unique index (P2002 → 409 on `body.email`).
- **Password:** 12–128 characters, not mostly whitespace, and not equal to the email. There are no composition rules, so passphrases and password-manager values work. This stays inside the login schema's 8–1024 range.
- **`outletIds`:** UUIDs, unique, at most 200.
- **Bodies are strict.** `role`, `isActive` (outside `/status`), `passwordHash`, ids and timestamps are rejected, not ignored, so a client can't escalate a role.

### Account and membership lifecycle

- **Create:**
  - The password is hashed with Argon2id (`common/security/password.ts`, shared with login and the admin seed) **before** the transaction opens.
  - The transaction locks the requested outlets `FOR SHARE` in id order and checks that they exist and are active.
  - It then inserts the user (`role = OUTLET_STAFF`, `isActive = true`, both set by the server) and all memberships.
  - Any failure rolls the whole thing back. A staff member may start with zero outlets.
- **Email change:** the new address becomes the login identifier immediately. Existing sessions are kept.
- **Deactivate:**
  - One transaction locks the user row `FOR UPDATE`, sets `is_active = false`, and revokes every unrevoked refresh session (`revoked_at = now()`, `revoke_reason = ADMIN_REVOKED`).
  - Memberships and sales are untouched.
  - Access tokens already issued are rejected on their next request, because `authenticate` re-checks `is_active` against the database.
- **Reactivate:** sets `is_active = true` only. Revoked sessions stay revoked, so the user must sign in again.
  - Any access token issued before deactivation that has not yet expired (at most `JWT_ACCESS_TTL_SECONDS`, 15 minutes) would work again. There is no access-token denylist.
  - Repeating the current status is a no-op.
- **Membership replacement (`PUT /outlets`):**
  - Idempotent: it sends the complete intended set.
  - One transaction locks the staff row `FOR UPDATE` (which serializes concurrent replacements for the same staff member), reads the current set, and computes additions and removals.
  - It then locks **only the added** outlets `FOR SHARE` in id order and requires them to exist and be active.
  - Removed rows are deleted, added rows inserted, and unchanged rows left alone.
  - A retained membership to an inactive outlet is allowed. It grants nothing, because access checks require `outlet.is_active`.
  - There is no optimistic concurrency token, so two administrators editing the same staff member get **last write wins**. Each request is applied atomically against the state it reads under the lock.
  - Sales are never touched.
- **Password reset:**
  - The new hash is computed before the transaction.
  - The transaction locks the user `FOR UPDATE`, replaces `password_hash`, and revokes every unrevoked refresh session (`ADMIN_REVOKED`).
  - The response is a generic `{}`. Nothing logs in as the staff member, and no temporary password is generated or emailed.
  - **Access tokens already issued stay valid until they expire (up to 15 minutes).** The account is still active, so `authenticate` accepts them. This is the documented limit of stateless JWTs in this design.
- **Hard deletion:** none. Historical sales keep their `created_by_id`.

### Concurrency between account changes and authentication

Login and refresh now take the same user-row lock that account changes take, so a stale credential cannot create a session after a reset or deactivation.

- **Login:**
  - Argon2 verification still runs outside any transaction.
  - The session insert then runs in a transaction that `SELECT … FOR SHARE`s the user and re-checks that the account is active and `password_hash` still equals the verified hash. If not, the login fails with the generic 401.
  - If a reset commits first, the re-check sees the new hash. If the login commits first, the reset waits for it and then revokes the new session.
- **Refresh rotation** (Serializable) also locks the user row `FOR SHARE` before rotating.
  - If a reset or deactivation committed concurrently, PostgreSQL raises a serialization failure, the existing single retry runs, and the retry sees the revoked session.
  - Deactivated users are rejected using the locked row's `is_active`.
- **Lock order is always user row, then sessions or memberships, then outlets in id order.** This prevents deadlocks between these paths.
- **Isolation levels:** Read Committed (PostgreSQL's default) for staff transactions and login, Serializable for rotation.
- **Testing:** the mocked tests check the orchestration (lock order, re-checks, rollback propagation). They do **not** prove PostgreSQL atomicity or lock behavior; the manual check below covers that.
- **Logs:** request bodies are never logged by `pino-http`, and the redaction list additionally covers `req.body`, `*.password` and `*.newPassword`.

### Manual database check (run only with approval; it writes to the shared database)

1. As an HQ admin, `POST /staff` with an active outlet's id. Confirm the 201 response contains no password fields, and that `SELECT password_hash FROM users WHERE email = …` starts with `$argon2id$`.
2. Repeat with the same email → 409. Repeat with an inactive outlet → 400, and no user row is created.
3. Sign in as the staff member, then `PATCH /staff/:id/status {"isActive":false}`. Check `refresh_sessions` shows `revoke_reason = ADMIN_REVOKED`. The staff member's next API call returns 401, and refresh returns 401.
4. Reactivate. The old refresh cookie is still rejected, and a fresh login works.
5. `PATCH /staff/:id/password`, then confirm the old password fails, the new one works, and all sessions created before the reset are revoked.
6. `PUT /staff/:id/outlets` with a set that keeps one outlet, drops one and adds one. The kept row's `created_at` is unchanged.
7. Race check: start a login with the old password and a password reset at the same moment (two terminals). Afterwards, no unrevoked session may exist with a `created_at` earlier than the reset.

## Master Menu API

All endpoints are under `/api/v1/menu-items` and require `HQ_ADMIN`. Outlet staff get 403; they will read outlet-specific assigned items from a phase 4 endpoint, never the global catalog.

| Method  | Path                             | Body                                      | Result                                   |
| ------- | -------------------------------- | ----------------------------------------- | ---------------------------------------- |
| `GET`   | `/menu-items`                    | –                                         | `{ items, pagination }`                  |
| `GET`   | `/menu-items/:menuItemId`        | –                                         | `{ menuItem }` (inactive items included) |
| `POST`  | `/menu-items`                    | `{ sku, name, description?, basePrice }`  | `201 { menuItem }`; `409` on `body.sku`  |
| `PATCH` | `/menu-items/:menuItemId`        | any of `{ name, description, basePrice }` | `{ menuItem }`                           |
| `PATCH` | `/menu-items/:menuItemId/status` | `{ isActive }`                            | `{ menuItem }`                           |

**Fields:** `id`, `sku`, `name`, `description` (nullable), `basePrice` (a money string), `isActive`, `createdAt`, `updatedAt`. Assignments, stock and sales are not returned in this phase.

**Listing:**

- Same `page`/`limit`/`status` contract as outlets.
- `search` matches SKU or name, case-insensitively.
- `sortBy` is `sku`, `name`, `basePrice`, `createdAt` or `updatedAt`, with `id` as the tie-breaker.
- Everything is applied in the database query.

**Rules:**

- **SKU:** trimmed and uppercased; 1–50 characters of letters, digits and single hyphens. It is **immutable**, because no update endpoint accepts it. Uniqueness comes from the database index, so concurrent duplicates give one 201 and one 409.
- **Name:** 1–150 characters after trimming. An empty description becomes `null`.
- **New items:** always created active, and never assigned to outlets automatically.
- **Strict bodies:** `sku` (on update), `isActive`, ids and timestamps are rejected.
- **Price changes:** `PATCH` writes only `menu_items` columns. Outlet `override_price`, stock, and the `unit_price`/`item_name` snapshots on `sale_items` are separate rows and are never touched.
- **Status changes:** a conditional `UPDATE … WHERE id = $1 AND is_active <> $2`. Repeating the current status changes nothing (not even `updatedAt`), and two concurrent toggles can't interleave. Assignments, stock, overrides and sales are preserved. There is no hard delete.

### Money contract

- **Format:** money is a JSON **string** matching `^(0|[1-9]\d{0,9})(\.\d{1,2})?$`, so 0 to `9999999999.99` (the `DECIMAL(12,2)` range).
- **Rejected:** JSON numbers, negative values, `NaN`, `Infinity`, exponents, leading zeros or `+`, more than 2 decimals (never rounded silently), and values out of range.
- **Normalization:** input is padded to two decimals as a string (`"5"` becomes `"5.00"`).
- **Storage:** the string is handed to Prisma's `Decimal` column as-is. Responses use `Decimal#toFixed(2)`.
- **No floats:** neither `Number` nor `parseFloat` is ever used.
- **Shared helper:** `src/common/money.ts` (`moneySchema`, `serializeMoney`) is intended for outlet price overrides and sales.
- **Currency:** a single currency, with no currency column. The frontend displays it as BDT (`৳`).

**NaN gap and the pending migration:**

- PostgreSQL `numeric` accepts `'NaN'` and sorts it above every number, so the existing `CHECK (base_price >= 0)` style constraints **accept NaN**. (`Infinity` is already rejected, because these columns declare a precision.)
- The API never writes NaN. As defence in depth, `20261126000000_money_not_nan` adds `<> 'NaN'::numeric` checks to `menu_items.base_price`, `outlet_menu_items.override_price`, `sales.total_amount`, `sale_items.unit_price` and `sale_items.line_total`.
- It is **not applied**. Apply it with approval via `pnpm db:migrate:status`, then `pnpm db:migrate:deploy`.
- It fails if a NaN value already exists. Check first with `SELECT count(*) FROM menu_items WHERE base_price = 'NaN'` (and similarly for the other columns).

### Rules for future outlet pricing and sales

- **Effective price:** `outlet_menu_items.override_price` when it is not null, otherwise `menu_items.base_price`.
- **Sellable only when all are active:** the outlet, the outlet assignment (`outlet_menu_items.is_active`) and the master item (`menu_items.is_active`). An inactive master item is never sellable, even if its assignment is active.
- **Locking inside the sale transaction:**
  - lock the outlet row `FOR SHARE`;
  - lock each `outlet_menu_items` row `FOR UPDATE` (stock is decremented);
  - lock each `menu_items` row `FOR SHARE`, in a consistent order such as by id;
  - re-check every `is_active`, compute the effective price **from the locked rows**, and copy `name` and price into `sale_items`.
- **Why:** `FOR SHARE` makes a concurrent deactivation or price edit wait until the sale commits, or makes the sale see the new values. Already-recorded sales keep their snapshot.

**Testing:**

- `tests/unit/menu-items.test.ts` covers HTTP, validation and authorization.
- `tests/unit/money.test.ts` covers precision cases.
- `tests/unit/menu-item-repository.test.ts` covers query shape, exact-string persistence, scalar-only updates and the conditional status update.
- These run against a mocked Prisma client and do not prove PostgreSQL behavior.

### Manual database check (run only with approval; it writes to the shared database)

1. `POST /menu-items {"sku":" coffee-001 ","name":"Cappuccino","basePrice":"180.5"}` → 201 with `sku: "COFFEE-001"` and `basePrice: "180.50"`. In SQL, `base_price` is `180.50`.
2. Send the same request twice in parallel: one 201 and one 409 on `body.sku`.
3. Check that `{"basePrice": 180}`, `"1.005"`, `"NaN"` and `"1e2"` each return 400.
4. `PATCH /menu-items/:id/status {"isActive":false}` twice. `updated_at` changes once. Any `outlet_menu_items` rows for the item keep `is_active`, `stock_quantity` and `override_price`.
5. Sign in as staff: `GET /menu-items` → 403.

## Docker (application only)

The Dockerfile has these stages:

- `production` (default runtime): non-root `nodeapp` user, production dependencies only, a `HEALTHCHECK` on `/api/v1/health/live` that respects `PORT`.
- `migrate`: a one-off `prisma migrate deploy` job.

Env files are excluded by `.dockerignore`, so no credentials are copied into any image.

```bash
cp .env.example .env.production      # NODE_ENV=production, COOKIE_SECURE=true, real secrets
docker compose config --quiet        # validate
docker compose up -d --build         # API on 127.0.0.1:${API_PORT:-3000}
docker compose ps
docker compose down
```

Compose has no database service. It reads `.env.production` at runtime and publishes the API on loopback only. The `migrate` service is behind the `migrate` profile and never starts with `up`.

## Coolify deployment

1. **Database:** create the PostgreSQL resource in Coolify. Copy its **internal** connection URL for the API, since the API runs on the same server. Use the public URL only for local access (see above).
2. **Application:** add a resource from the Git repository. Use build pack **Dockerfile**, base directory `/` (this repository's root), and Dockerfile `Dockerfile` (the final stage, `production`, is the default target). Set the port to `3000`, or whatever `PORT` you set.
3. **Domain/HTTPS:** assign the domain (for example `https://api.example.com`). Coolify's Traefik proxy gets the certificate and terminates TLS. It forwards `X-Forwarded-Proto` and `X-Forwarded-For`.
4. **Environment variables** (runtime, not build-time). Mark secrets as secret:

   ```dotenv
   NODE_ENV=production
   DATABASE_URL=<internal Coolify URL>
   DATABASE_POOL_MAX=5
   JWT_SECRET=<≥32 random chars, e.g. `openssl rand -base64 48`>
   JWT_ISSUER=outlet-hub
   JWT_AUDIENCE=outlet-hub-web
   ALLOWED_ORIGINS=https://<frontend-domain>
   TRUST_PROXY=1
   COOKIE_SECURE=true
   COOKIE_SAME_SITE=strict      # use `none` only if the frontend is on a different site
   LOG_LEVEL=info
   LOG_PRETTY=false
   SWAGGER_ENABLED=false
   ```

5. **Health check:** the image's Docker `HEALTHCHECK` is used automatically. If you configure Coolify's own check, use path `/api/v1/health/live`. Use `/api/v1/health/ready` for database readiness monitoring.
6. **Migrations:** apply pending migrations explicitly _before_ deploying code that needs them (`pnpm db:migrate:deploy` from a trusted machine). Deployments never migrate automatically.

`TRUST_PROXY=1` makes the client IP (used for rate limiting) and the request protocol (used for Secure cookies) come from exactly one trusted hop, Coolify's proxy. Do not set it higher unless another proxy, such as Cloudflare, sits in front.

## Commands

| Command                             | Action                                                         |
| ----------------------------------- | -------------------------------------------------------------- |
| `pnpm dev`                          | Watch-mode server (`.env.development`)                         |
| `pnpm build` / `pnpm start`         | Compile / run compiled output                                  |
| `pnpm typecheck`                    | Strict TypeScript validation                                   |
| `pnpm lint` / `pnpm lint:fix`       | ESLint validation / fix                                        |
| `pnpm format:check` / `pnpm format` | Prettier validation / fix                                      |
| `pnpm test` / `pnpm test:watch`     | Database-independent unit tests                                |
| `pnpm test:coverage`                | Coverage report                                                |
| `pnpm verify`                       | Lint, typecheck, format check, tests, and build                |
| `pnpm security:audit`               | High-severity production dependency audit                      |
| `pnpm prisma:generate`              | Generate the typed Prisma client                               |
| `pnpm db:migrate:diff`              | Read-only: print SQL from the live DB to `schema.prisma`       |
| `pnpm db:migrate:status`            | Read-only: show applied/pending migrations                     |
| `pnpm db:migrate:deploy`            | Apply committed migrations (**writes to the shared database**) |
| `pnpm db:seed:admin`                | Explicitly seed/rotate the HQ admin (**writes**)               |

There is no external CI. Coolify builds from Git. Husky runs lint-staged on commit and enforces Conventional Commits. Run `pnpm verify && pnpm security:audit` before pushing.

## Security considerations

- Helmet sets API-focused security headers, and Express fingerprinting is disabled. CORS and state-changing cookie endpoints use exact origin allowlists. All input is validated.
- Prisma parameterizes queries. Raw SQL is limited to the static readiness query and committed migrations.
- Use `sslmode=require` with `sslrootcert` for any connection over the internet. Prefer an SSH tunnel or the internal Coolify network over a publicly exposed port. If a port must be exposed, restrict it by IP.
- Credentials exist only in ignored env files or in Coolify's runtime variables. They are never in Git, the build context, or image layers.
- Authorization headers, cookies, passwords, tokens, `DATABASE_URL`, and `JWT_SECRET` are redacted from logs. Production responses hide internal errors.
- The rate-limit store is process-local. Before running multiple replicas, use a shared store such as Redis.
- Keep `replicas × DATABASE_POOL_MAX` for every consumer (local and deployed) below the database's connection limit.
- Swagger UI is forced off in production. Restrict `/openapi.json` at the proxy if the schema must not be public.
- Because the database is shared, treat every developer machine as production-privileged. For anything beyond this assessment, separate the environments.
