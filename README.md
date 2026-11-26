# OutletHub Backend

Production-oriented backend for OutletHub, a multi-outlet POS management system. It implements:

- authentication and session management;
- **Outlet Management**;
- **Staff & Outlet Membership Management**;
- **Master Menu Management**;
- **Outlet Menu Assignment & Price Overrides**;
- **Inventory Management**;
- **POS Sales with idempotent checkout and sequential per-outlet receipts**;
- **Revenue Reporting**;
- health checks.

OutletHub records sales; it does not process payments.

**Documentation:**

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the implemented architecture, the scaling plan, a microservices evolution and an offline POS/KDS strategy.
- [docs/VERIFICATION.md](docs/VERIFICATION.md): every executed check and its result.
- [erd-diagram.pdf](erd-diagram.pdf) and [flowchart-diagram.pdf](flowchart-diagram.pdf).

## Table of contents

- [Setup](#setup)
  - [Stack](#stack)
  - [Shared database (intentional, assessment only)](#shared-database-intentional-assessment-only)
  - [Environments](#environments)
  - [Local development](#local-development)
  - [Database migrations and seed](#database-migrations-and-seed)
  - [Demo data (configured database)](#demo-data-configured-database)
  - [Docker (application only)](#docker-application-only)
  - [Full stack with Docker (API + frontend, external database)](#full-stack-with-docker-api--frontend-external-database)
  - [Coolify deployment](#coolify-deployment)
  - [Commands](#commands)
- [API Endpoints](#api-endpoints)
  - [Authentication API](#authentication-api)
  - [Outlets API](#outlets-api)
  - [Staff API](#staff-api)
  - [Master Menu API](#master-menu-api)
  - [Outlet Menu API](#outlet-menu-api)
  - [Inventory API](#inventory-api)
  - [Sales API (POS and receipts)](#sales-api-pos-and-receipts)
  - [Reports API (HQ_ADMIN only)](#reports-api-hq_admin-only)
- [Database Schema](#database-schema)
- [Architecture](#architecture)
- [Scaling Strategy](#scaling-strategy)
  - [a. Database scaling](#a-database-scaling)
  - [b. Reporting performance](#b-reporting-performance)
  - [c. Infrastructure](#c-infrastructure)
  - [d. Architectural evolution](#d-architectural-evolution)
  - [Microservices evolution (summary)](#microservices-evolution-summary)
  - [Offline POS & KDS (summary)](#offline-pos--kds-summary)
- [Verification](#verification)
  - [API integration verification (real HTTP, real PostgreSQL)](#api-integration-verification-real-http-real-postgresql)
- [Known limitations](#known-limitations)
- [Security considerations](#security-considerations)

## Setup

### Stack

- Node.js 24 LTS, Express 5, strict TypeScript, pnpm
- External PostgreSQL (Coolify-managed), Prisma ORM 7 with the `pg` driver adapter
- Zod configuration/request validation
- Argon2id passwords, HS256 JWT access tokens, opaque rotating refresh tokens
- Pino structured logging, Helmet, strict CORS/origin checks, layered rate limits
- OpenAPI 3 and development-only Swagger UI
- Vitest, Supertest, ESLint, Prettier, Husky, lint-staged, Commitlint
- Multi-stage Dockerfile and an application-only Docker Compose file, deployed via Coolify

### Shared database (intentional, assessment only)

There are no real users, so **local development and production intentionally connect to the same Coolify-managed PostgreSQL database**. No database runs in Docker, and there is no separate test database.

Consequences to keep in mind:

- Every local action (logins, refresh-session rows, seeds, migrations) changes production data immediately.
- A migration applied from a laptop is applied to production. A bad migration breaks production.
- Developer machines hold production credentials; a leaked `.env.development` is a production breach.
- Local and deployed instances share the connection limit; keep `DATABASE_POOL_MAX` small on both.
- Never run `prisma migrate dev`, `migrate reset`, or `db push` here. They can drop data. That is why `migrate dev` has no script.

For a real product, use separate databases per environment, least-privilege roles (a runtime role without DDL rights, a separate migration role), and backups with tested restores.

### Environments

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
| `PORT`                                               | Listener port (default `8000`); the server always binds `0.0.0.0` |
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

### Local development

Requirements: Node.js 24 LTS and pnpm 12. No local PostgreSQL or Docker is needed.

```bash
pnpm install --frozen-lockfile
cp .env.example .env.development   # fill in DATABASE_URL, JWT_SECRET, …
pnpm prisma:generate
pnpm db:migrate:status               # read-only check against the shared database
pnpm dev
```

The API listens on `http://localhost:8000`. Swagger UI is at `/docs` when `SWAGGER_ENABLED=true` outside production. The OpenAPI document is at `/openapi.json`.

#### Connecting securely to the Coolify PostgreSQL

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

### Database migrations and seed

The schema is managed only through committed SQL migrations in `prisma/migrations/`. Nothing runs migrations or seeds automatically: not app startup, not the Docker build, not tests.

| Migration                        | Contents                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261125000000_initial_auth`    | Users and refresh sessions                                                                                                                      |
| `20261125100000_business_domain` | Outlets, memberships, menu items, outlet stock/pricing, receipt counters, sales, sale items, and database CHECK constraints                     |
| `20261126000000_money_not_nan`   | **Applied** to the configured database (verified: all five constraints present and validated). Additive `<> 'NaN'` checks on every money column |

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

### Demo data (configured database)

`pnpm db:seed:demo` (`prisma/seed-demo.ts`) seeds realistic demonstration data into the **configured** database through the production services. Outlets go through the outlet + receipt-counter transaction, staff through Argon2id hashing, assignments, stock through the guarded adjustment, and every sale through `SaleService.create`.

**What it creates:**

- Five outlets: `DEMO-MIRPUR`, `DEMO-GULSHAN`, `DEMO-DHANMONDI`, `DEMO-UTTARA` (assigned items and stock, no sales) and `DEMO-BANANI` (historical sales, then deactivated).
- 32 master items (2 retired), 115 assignments: inherited and override prices, one `0.00` override, 3 inactive assignments, and high, medium, low and zero stock.
- Six `OUTLET_STAFF` accounts (`staff.*@example.com`).
- 400 historical sales over the 30 days before the first seeding day. The plan was capped from 500 to 400 after 325 sales existed; those are kept, and the remaining 75 are spread evenly over the final days. The seed refuses to run if any demo sale lies outside the plan.

**Safety and idempotency:**

- Everything is namespaced (`DEMO-` codes and SKUs). The seed refuses to touch a same-named record that is not demo data.
- Sales use deterministic request ids. The plan is anchored to the demo Mirpur outlet's creation day, so re-runs reproduce the same plan.
- Stock is replenished once, to the target balance plus the planned consumption, and never reset after sales exist.
- Historical timestamps are applied only to sales created by the seed's own deterministic request ids.
- Banani is deactivated only after all of its planned sales exist.
- An interrupted run resumes where it stopped. This was tested by killing a rehearsal run at 225 sales; the resumed run reached an identical end state.

**Passwords:**

- New accounts get random passwords. They are printed once and, with `DEMO_CREDENTIALS_FILE=<path>`, written to a `0600` file outside the repository.
- Re-runs never rotate them. `pnpm db:seed:demo --rotate-demo-passwords` explicitly issues new passwords for the demo staff accounts only.
- Passwords are never stored in source or docs.

`pnpm db:audit` is read-only. It prints counts, integrity checks (separately for demo and existing data) and business figures for the configured database.

### Docker (application only)

The Dockerfile has these stages:

- `production` (default runtime): non-root `nodeapp` user, production dependencies only, a `HEALTHCHECK` on `/api/v1/health/live` that respects `PORT`.
- `migrate`: a one-off `prisma migrate deploy` job.

Env files are excluded by `.dockerignore`, so no credentials are copied into any image.

```bash
cp .env.example .env.production      # NODE_ENV=production, COOKIE_SECURE=true, real secrets
docker compose config --quiet        # validate
docker compose up -d --build         # API on 127.0.0.1:${API_PORT:-8000}
docker compose ps
docker compose down
```

Compose has **no database service, by design**. The database is the external Coolify-managed PostgreSQL and stays outside Docker; point `DATABASE_URL` at it. Compose reads `.env.production` at runtime and publishes the API on loopback only. The `migrate` service is behind the `migrate` profile and never starts with `up`.

### Full stack with Docker (API + frontend, external database)

Both applications have their own Compose file. The database is **intentionally external**: the Coolify-managed PostgreSQL is not containerized, and neither Compose file contains a database service.

| Repository                                                              | Compose service                             | Published on                  |
| ----------------------------------------------------------------------- | ------------------------------------------- | ----------------------------- |
| [outlet-hub-backend](https://github.com/sakib-xrz/outlet-hub-backend)   | `api` (plus the optional `migrate` profile) | `127.0.0.1:${API_PORT:-8000}` |
| [outlet-hub-frontend](https://github.com/sakib-xrz/outlet-hub-frontend) | `web` (nginx serving the built SPA)         | `127.0.0.1:${WEB_PORT:-5173}` |

**1. API.** In this repository, create `.env.production`. Use placeholders here; put real secrets only in that ignored file.

```dotenv
NODE_ENV=production
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<database>?sslmode=require
JWT_SECRET=<at least 32 random characters>
ALLOWED_ORIGINS=http://localhost:5173      # must equal the web origin exactly
COOKIE_SECURE=true                         # required in production; browsers accept it on http://localhost
COOKIE_SAME_SITE=strict
TRUST_PROXY=0                              # 1 behind Coolify/Traefik
```

```bash
docker compose up -d --build               # API on http://localhost:8000
```

**2. Frontend.** In the frontend repository:

```bash
VITE_API_BASE_URL=http://localhost:8000/api/v1 docker compose up -d --build   # SPA on http://localhost:5173
```

**3. The three values must agree:**

- `VITE_API_BASE_URL` (frontend, build time) must point at the API, including `/api/v1`. Its origin is also written into the SPA's CSP `connect-src`.
- `ALLOWED_ORIGINS` (API, runtime) must contain the SPA's exact origin, for example `http://localhost:5173`. Otherwise CORS and the cookie endpoints refuse the browser.
- `localhost:5173` and `localhost:8000` are the same site, so the `SameSite=Strict` refresh cookie works locally. In production, put the two on subdomains of one registrable domain, use HTTPS and set `COOKIE_SECURE=true`.

The API Compose file always runs with `NODE_ENV=production`, which requires `COOKIE_SECURE=true`. That still works over plain HTTP on `localhost`, because browsers treat `http://localhost` as a secure context. On any other host, put both apps behind HTTPS.

### Coolify deployment

1. **Database:** create the PostgreSQL resource in Coolify. Copy its **internal** connection URL for the API, since the API runs on the same server. Use the public URL only for local access (see above).
2. **Application:** add a resource from the Git repository. Use build pack **Dockerfile**, base directory `/` (this repository's root), and Dockerfile `Dockerfile` (the final stage, `production`, is the default target). Set the port to `8000`, or whatever `PORT` you set.
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

### Commands

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
| `pnpm verify:sales-concurrency`     | Concurrency scenarios on a **local disposable** database only  |
| `pnpm verify:reports`               | Report fixtures and checks on a **local disposable** database  |
| `pnpm verify:api`                   | Full HTTP business flow on a **local disposable** database     |
| `pnpm db:seed:demo`                 | Idempotent demo data in the configured database (**writes**)   |
| `pnpm db:audit`                     | Read-only counts and integrity checks                          |

There is no external CI. Coolify builds from Git. Husky runs lint-staged on commit and enforces the commit message style (an imperative, sentence-case subject such as "Add inventory API", max 120 chars). Run `pnpm verify && pnpm security:audit` before pushing.

## API Endpoints

All paths are under `/api/v1`. Every response uses the envelope `{ success, message, data }`; errors use `{ success: false, message, code, requestId, errors? }`. Full request and response schemas are in `/openapi.json` and in Swagger UI (`/docs`, development only).

"Member staff" means `OUTLET_STAFF` with an active membership of that outlet, and the outlet must be active. Other staff get `403`, so the API does not reveal whether an outlet exists.

| Method  | Path                                               | Role / access                                                | Purpose                                                                       |
| ------- | -------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `POST`  | `/auth/login`                                      | Public; trusted `Origin`; rate-limited                       | Sign in; returns an access token and sets the refresh cookie                  |
| `POST`  | `/auth/refresh`                                    | Refresh cookie; trusted `Origin`; rate-limited               | Rotate the refresh token and issue a new access token                         |
| `POST`  | `/auth/logout`                                     | Refresh cookie; trusted `Origin`                             | Revoke the session and clear the cookie                                       |
| `GET`   | `/auth/me`                                         | Any authenticated user                                       | Current user                                                                  |
| `GET`   | `/outlets`                                         | Any authenticated user (staff see only their active outlets) | List, search, filter and sort outlets                                         |
| `POST`  | `/outlets`                                         | `HQ_ADMIN`                                                   | Create an outlet and its receipt counter in one transaction                   |
| `GET`   | `/outlets/:outletId`                               | `HQ_ADMIN` or member staff                                   | Outlet details                                                                |
| `PATCH` | `/outlets/:outletId`                               | `HQ_ADMIN`                                                   | Update name or address (the code is immutable)                                |
| `PATCH` | `/outlets/:outletId/status`                        | `HQ_ADMIN`                                                   | Activate or deactivate an outlet                                              |
| `GET`   | `/staff`                                           | `HQ_ADMIN`                                                   | List staff accounts                                                           |
| `POST`  | `/staff`                                           | `HQ_ADMIN`                                                   | Create an `OUTLET_STAFF` account with outlet memberships                      |
| `GET`   | `/staff/:staffId`                                  | `HQ_ADMIN`                                                   | Staff details and memberships                                                 |
| `PATCH` | `/staff/:staffId`                                  | `HQ_ADMIN`                                                   | Change the email                                                              |
| `PATCH` | `/staff/:staffId/status`                           | `HQ_ADMIN`                                                   | Activate or deactivate (revokes sessions)                                     |
| `PUT`   | `/staff/:staffId/outlets`                          | `HQ_ADMIN`                                                   | Replace the outlet memberships                                                |
| `PATCH` | `/staff/:staffId/password`                         | `HQ_ADMIN`; rate-limited                                     | Reset the password (revokes sessions)                                         |
| `GET`   | `/menu-items`                                      | `HQ_ADMIN`                                                   | List the master menu                                                          |
| `POST`  | `/menu-items`                                      | `HQ_ADMIN`                                                   | Create a master menu item                                                     |
| `GET`   | `/menu-items/:menuItemId`                          | `HQ_ADMIN`                                                   | Master item details                                                           |
| `PATCH` | `/menu-items/:menuItemId`                          | `HQ_ADMIN`                                                   | Update name, description or base price                                        |
| `PATCH` | `/menu-items/:menuItemId/status`                   | `HQ_ADMIN`                                                   | Activate or deactivate a master item                                          |
| `GET`   | `/outlets/:outletId/menu-items`                    | `HQ_ADMIN` or member staff (staff see enabled items only)    | Outlet menu with effective price and stock                                    |
| `POST`  | `/outlets/:outletId/menu-items`                    | `HQ_ADMIN`                                                   | Assign a master item, optionally with an override price                       |
| `GET`   | `/outlets/:outletId/menu-items/:menuItemId`        | `HQ_ADMIN` or member staff                                   | One assignment                                                                |
| `PATCH` | `/outlets/:outletId/menu-items/:menuItemId/price`  | `HQ_ADMIN`                                                   | Set or clear the override price                                               |
| `PATCH` | `/outlets/:outletId/menu-items/:menuItemId/status` | `HQ_ADMIN`                                                   | Enable or disable the assignment                                              |
| `GET`   | `/outlets/:outletId/inventory`                     | `HQ_ADMIN` or member staff                                   | Stock balances, filterable by stock level                                     |
| `GET`   | `/outlets/:outletId/inventory/:menuItemId`         | `HQ_ADMIN` or member staff                                   | One stock balance                                                             |
| `PATCH` | `/outlets/:outletId/inventory/:menuItemId/adjust`  | `HQ_ADMIN`                                                   | `INCREASE`, `DECREASE` or `SET` (with the expected quantity) under a row lock |
| `POST`  | `/outlets/:outletId/sales`                         | Member `OUTLET_STAFF`                                        | Create a sale (idempotent by request id; 201 new, 200 replay)                 |
| `GET`   | `/outlets/:outletId/sales`                         | `HQ_ADMIN` or member staff                                   | Sales history (search, sort, half-open date range)                            |
| `GET`   | `/outlets/:outletId/sales/by-request/:requestId`   | Member `OUTLET_STAFF`                                        | Resolve an uncertain checkout by its request id                               |
| `GET`   | `/outlets/:outletId/sales/:saleId`                 | `HQ_ADMIN` or member staff                                   | Receipt and sale details                                                      |
| `GET`   | `/reports/summary`                                 | `HQ_ADMIN`                                                   | Revenue, sale count, units sold and outlet counts                             |
| `GET`   | `/reports/revenue-by-outlet`                       | `HQ_ADMIN`                                                   | Paginated revenue per outlet, including zero-sale and inactive outlets        |
| `GET`   | `/reports/outlets/:outletId/top-selling-items`     | `HQ_ADMIN`                                                   | Top five items of one outlet by quantity                                      |
| `GET`   | `/health/live`                                     | Public                                                       | Process liveness (no database dependency)                                     |
| `GET`   | `/health/ready`                                    | Public                                                       | Readiness, including a database ping with a timeout                           |

Outside `/api/v1`, `GET /openapi.json` serves the OpenAPI document. Swagger UI is mounted at `/docs` only when `SWAGGER_ENABLED=true` outside production.

The sections below describe each module in detail.

### Authentication API

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

### Outlets API

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

#### Manual database check (run only with approval; it writes to the shared database)

1. Start the API and sign in as an HQ admin to get an access token.
2. `POST /outlets {"code":" smoke-01 ","name":"Smoke"}` → 201 with code `SMOKE-01`. Then run `SELECT last_number FROM receipt_counters WHERE outlet_id = '<id>'` and confirm it is `0`.
3. Send the same `POST` twice in parallel. One returns 201 and the other 409.
4. `PATCH /outlets/<id>/status {"isActive":false}`, then repeat it. Both return 200 with `isActive: false`, and `updated_at` changes only once.
5. Sign in as a staff user who has a membership row for the outlet. `GET /outlets/<id>` returns 403 while the outlet is inactive and 200 after reactivation. `GET /outlets` shows the outlet only while it is active.
6. `PATCH /outlets/<id> {"code":"X-1"}` returns 400, and the code is unchanged.
7. Optional rollback check, only on a throwaway database: drop the counter table's write permission for the API role (`REVOKE INSERT ON receipt_counters FROM <role>`). `POST /outlets` should then return 500 with no new row in `outlets`. Restore the permission afterwards.

### Staff API

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

#### Account and membership lifecycle

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

#### Concurrency between account changes and authentication

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

#### Manual database check (run only with approval; it writes to the shared database)

1. As an HQ admin, `POST /staff` with an active outlet's id. Confirm the 201 response contains no password fields, and that `SELECT password_hash FROM users WHERE email = …` starts with `$argon2id$`.
2. Repeat with the same email → 409. Repeat with an inactive outlet → 400, and no user row is created.
3. Sign in as the staff member, then `PATCH /staff/:id/status {"isActive":false}`. Check `refresh_sessions` shows `revoke_reason = ADMIN_REVOKED`. The staff member's next API call returns 401, and refresh returns 401.
4. Reactivate. The old refresh cookie is still rejected, and a fresh login works.
5. `PATCH /staff/:id/password`, then confirm the old password fails, the new one works, and all sessions created before the reset are revoked.
6. `PUT /staff/:id/outlets` with a set that keeps one outlet, drops one and adds one. The kept row's `created_at` is unchanged.
7. Race check: start a login with the old password and a password reset at the same moment (two terminals). Afterwards, no unrevoked session may exist with a `created_at` earlier than the reset.

### Master Menu API

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

#### Money contract

- **Format:** money is a JSON **string** matching `^(0|[1-9]\d{0,9})(\.\d{1,2})?$`, so 0 to `9999999999.99` (the `DECIMAL(12,2)` range).
- **Rejected:** JSON numbers, negative values, `NaN`, `Infinity`, exponents, leading zeros or `+`, more than 2 decimals (never rounded silently), and values out of range.
- **Normalization:** input is padded to two decimals as a string (`"5"` becomes `"5.00"`).
- **Storage:** the string is handed to Prisma's `Decimal` column as-is. Responses use `Decimal#toFixed(2)`.
- **No floats:** neither `Number` nor `parseFloat` is ever used.
- **Shared helper:** `src/common/money.ts` (`moneySchema`, `serializeMoney`) is intended for outlet price overrides and sales.
- **Currency:** a single currency, with no currency column. The frontend displays it as BDT (`৳`).

**NaN guard migration:**

- PostgreSQL `numeric` accepts `'NaN'` and sorts it above every number, so the existing `CHECK (base_price >= 0)` style constraints **accept NaN**. (`Infinity` is already rejected, because these columns declare a precision.)
- The API never writes NaN. As defence in depth, `20261126000000_money_not_nan` adds `<> 'NaN'::numeric` checks to `menu_items.base_price`, `outlet_menu_items.override_price`, `sales.total_amount`, `sale_items.unit_price` and `sale_items.line_total`.
- It is applied to the configured database. All five constraints are present and validated, and no NaN values exist; `pnpm db:audit` re-checks this. On a new database it is applied by `pnpm db:migrate:deploy` with the rest of the history. It would fail if a NaN value already existed.

#### Rules for future outlet pricing and sales

- **Effective price:** `outlet_menu_items.override_price` when it is not null, otherwise `menu_items.base_price`.
- **Sellable only when all are active:** the outlet, the outlet assignment (`outlet_menu_items.is_active`) and the master item (`menu_items.is_active`). An inactive master item is never sellable, even if its assignment is active.
- **Locking inside the sale transaction:** follow the global lock order in [Outlet menu: locking](#locking-and-the-global-lock-order) (outlet `FOR SHARE`, receipt counter, assignments `FOR UPDATE` by `menu_item_id`, master items `FOR SHARE` by `id`). Then re-check every `is_active`, compute the effective price **from the locked rows**, and copy `name` and price into `sale_items`.
- **Why:** `FOR SHARE` makes a concurrent deactivation or price edit wait until the sale commits, or makes the sale see the new values. Already-recorded sales keep their snapshot.

**Testing:**

- `tests/unit/menu-items.test.ts` covers HTTP, validation and authorization.
- `tests/unit/money.test.ts` covers precision cases.
- `tests/unit/menu-item-repository.test.ts` covers query shape, exact-string persistence, scalar-only updates and the conditional status update.
- These run against a mocked Prisma client and do not prove PostgreSQL behavior.

#### Manual database check (run only with approval; it writes to the shared database)

1. `POST /menu-items {"sku":" coffee-001 ","name":"Cappuccino","basePrice":"180.5"}` → 201 with `sku: "COFFEE-001"` and `basePrice: "180.50"`. In SQL, `base_price` is `180.50`.
2. Send the same request twice in parallel: one 201 and one 409 on `body.sku`.
3. Check that `{"basePrice": 180}`, `"1.005"`, `"NaN"` and `"1e2"` each return 400.
4. `PATCH /menu-items/:id/status {"isActive":false}` twice. `updated_at` changes once. Any `outlet_menu_items` rows for the item keep `is_active`, `stock_quantity` and `override_price`.
5. Sign in as staff: `GET /menu-items` → 403.

### Outlet Menu API

Endpoints are nested under an outlet: `/api/v1/outlets/:outletId/menu-items`. An assignment is identified by the **pair** `(outletId, menuItemId)`, the table's composite primary key. It is never looked up by `menuItemId` alone.

| Method  | Path                                               | Access                                     | Body                                   |
| ------- | -------------------------------------------------- | ------------------------------------------ | -------------------------------------- |
| `GET`   | `/outlets/:outletId/menu-items`                    | HQ admin; staff with access to that outlet | –                                      |
| `GET`   | `/outlets/:outletId/menu-items/:menuItemId`        | HQ admin; staff with access to that outlet | –                                      |
| `POST`  | `/outlets/:outletId/menu-items`                    | `HQ_ADMIN`                                 | `{ menuItemId, overridePrice? }`       |
| `PATCH` | `/outlets/:outletId/menu-items/:menuItemId/price`  | `HQ_ADMIN`                                 | `{ overridePrice }` (string or `null`) |
| `PATCH` | `/outlets/:outletId/menu-items/:menuItemId/status` | `HQ_ADMIN`                                 | `{ isActive }`                         |

The router is mounted before the outlets router (`mergeParams`), so these paths are authenticated once.

**Response (`OutletMenuItem`):**

- **Identity:** `outletId`, `menuItemId`.
- **From the master item:** `sku`, `name`, `description`.
- **Prices (money strings):** `basePrice`, `overridePrice` (nullable), `effectivePrice`.
- **`priceSource`:** `BASE` or `OVERRIDE`.
- **`stockQuantity`:** read-only in this phase.
- **Status flags:** `isActive` (the assignment), `outletIsActive`, `menuItemIsActive`, `isEnabled` and `isSellable`.
- **Timestamps:** `createdAt`, `updatedAt` (of the assignment).

#### Pricing

- `effectivePrice = overridePrice ?? basePrice`, computed with nullish coalescing on `Decimal` values. `"0.00"` is therefore a real override, and only `null` falls back. The effective price is computed per response and never stored.
- `PATCH …/price {"overridePrice": null}` restores inheritance: later master `basePrice` changes then apply to this outlet automatically. A non-null override applies only to this outlet.
- Prices use the same money contract as the master menu (`src/common/money.ts`).

#### Availability

- `isEnabled = outletIsActive && menuItemIsActive && isActive`.
- `isSellable = isEnabled && stockQuantity > 0`.
- **HQ admins** see every assignment of any existing outlet, including inactive outlets. The flags explain why an item is unavailable.
- **Outlet staff** must pass `requireOutletAccess` (403 for an outlet they don't belong to, or an inactive one). Their queries also carry `outlet.is_active`, `memberships some userId`, `menu_items.is_active` and `outlet_menu_items.is_active` **inside the Prisma `where`**, for both the items and the count.
  - Enabled items with zero stock are included, so the UI can show "Out of stock".
  - Disabled or unassigned items return 404 on the detail endpoint and never appear in lists.

#### Listing

- Same `page`/`limit` contract as other lists.
- `search` matches the master SKU or name.
- `status` filters by assignment status.
- `sortBy` is `sku`, `name`, `createdAt` or `updatedAt`, with `menuItemId` as the tie-breaker. Sorting by effective price is not offered, because it can't be done in the database before pagination without a computed column.

#### Assignment lifecycle

- **Assign:** needs an active outlet and an active master item. The assignment starts with `stockQuantity = 0` and `isActive = true`, and `overridePrice` defaults to `null`. Bodies are strict: stock, status, effective price, `outletId` and timestamps are rejected.
- **One assignment per outlet and item:** an existing assignment returns 409 on `body.menuItemId`. An inactive one tells the admin to reactivate it instead. A concurrent duplicate insert hits the composite key (P2002 → 409).
- **Deactivate:** a soft unassignment, always allowed, even under an inactive outlet or master item.
- **Reactivate:** needs both parents active (409 otherwise), and keeps stock and the override.
- **Repeated status requests:** no write and no `updatedAt` bump.
- **Price changes:** allowed on inactive assignments and inactive outlets.
- **Never touched:** nothing is hard-deleted, stock is never written, the master item is never written, and `sale_items` are never touched.
- **No automatic assignments:** creating a master item assigns it nowhere.

#### Locking and the global lock order

Every transaction that writes these tables takes row locks in this order. It is consistent with the auth and staff paths from earlier phases.

```text
users  →  outlets  →  receipt_counters  →  outlet_menu_items (by menu_item_id)  →  menu_items (by id)
```

| Path                                  | Locks taken                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login / refresh                       | `users FOR SHARE`                                                                                                                                                                                                                                             |
| Staff status / password reset         | `users FOR UPDATE`, then sessions                                                                                                                                                                                                                             |
| Membership replacement / staff create | `users FOR UPDATE` (replacement), then `outlets FOR SHARE` (by id)                                                                                                                                                                                            |
| Outlet status                         | `UPDATE outlets` (row lock on that outlet only)                                                                                                                                                                                                               |
| Master item status / edit             | `UPDATE menu_items` (row lock on that item only)                                                                                                                                                                                                              |
| **Assign**                            | admin `users FOR SHARE`, outlet `FOR SHARE`, assignment `FOR UPDATE` (if one exists), master item `FOR SHARE`, `INSERT`                                                                                                                                       |
| **Price override**                    | admin `users FOR SHARE`, outlet `FOR SHARE`, assignment `FOR UPDATE`, `UPDATE override_price` only                                                                                                                                                            |
| **Assignment status**                 | admin `users FOR SHARE`, outlet `FOR SHARE`, assignment `FOR UPDATE`, master item `FOR SHARE` (reactivation only), `UPDATE is_active` only                                                                                                                    |
| **Stock adjustment**                  | admin `users FOR SHARE`, outlet `FOR SHARE` (must be active), assignment `FOR UPDATE`, `UPDATE stock_quantity` only                                                                                                                                           |
| **Sale**                              | cashier `users FOR SHARE` (+ membership check), outlet `FOR SHARE`, `receipt_counters FOR UPDATE`, assignments `FOR UPDATE` by `menu_item_id`, master items `FOR SHARE` by `id`, guarded stock `UPDATE`s, counter `UPDATE … RETURNING`, `INSERT` sale + lines |

- **Admin re-check:** each write re-checks, under a shared lock, that the acting user is still an active `HQ_ADMIN`.
- **Parent checks are atomic:** they happen while the parents are locked `FOR SHARE`, so a concurrent outlet or master-item deactivation (an `UPDATE`) either waits for the assignment to commit or is seen as inactive.
- **No read-modify-write on stock:** price and status writes update a single column, so they can't overwrite a stock change made by a future inventory or sales transaction. The assignment row lock serializes them with those transactions.
- **Missing assignment rows:** these can't be locked, so for inserts the composite primary key is the final arbiter.
- **Deadlocks:** the single global order makes them unlikely, not impossible (for example with lock upgrades or code that strays from the order). PostgreSQL detects them and aborts one transaction, which surfaces as a 500 to retry.

**Future sale transaction (Read Committed), in order:**

1. `users FOR SHARE` for the cashier: re-check `is_active` and membership of the outlet. Membership replacement takes `users FOR UPDATE`, so the two serialize.
2. `outlets FOR SHARE`: the outlet must be active.
3. `receipt_counters FOR UPDATE` for that outlet: increment `last_number`.
4. `outlet_menu_items FOR UPDATE` for every line, ordered by `menu_item_id`: assignment active, stock sufficient, then decrement.
5. `menu_items FOR SHARE` ordered by `id`: master item active.
6. Compute `override_price ?? base_price` **from the locked rows** with exact decimals, and insert `sales` and `sale_items` with name and price snapshots.

**Testing:**

- `tests/unit/outlet-menu-items.test.ts` covers HTTP behavior: authorization, staff scoping, cross-outlet isolation, strict bodies, money edge cases, conflict mapping and status rules.
- `tests/unit/outlet-menu-item-repository.test.ts` covers:
  - effective price and availability, including the zero override;
  - the staff `where` clause in both query and count;
  - the exact lock sequence for every write;
  - parent-status rules, idempotent status, and that stock and master rows are never written.
- These use a mocked Prisma client and **do not prove PostgreSQL locking or atomicity**.

#### Manual database check (run only with approval; it writes to the shared database)

1. Create (or reuse) an active outlet and an active master item. Then `POST /outlets/:o/menu-items {"menuItemId": "…"}` → 201 with `stockQuantity: 0`, `priceSource: "BASE"`, and `effectivePrice` equal to `basePrice`.
2. Repeat the request → 409. Send it twice in parallel → one 201 and one 409.
3. `PATCH …/price {"overridePrice":"0"}` → `effectivePrice: "0.00"`, `priceSource: "OVERRIDE"`. Then `{"overridePrice": null}` → back to `BASE`. Change the master `basePrice`; the assignment's `effectivePrice` follows it.
4. `PATCH …/status {"isActive":false}` twice. `updated_at` changes once, and `stock_quantity` and `override_price` are unchanged in SQL.
5. Deactivate the master item, then try `PATCH …/status {"isActive":true}` → 409. Deactivating the assignment still works.
6. As a staff member of the outlet, `GET /outlets/:o/menu-items` lists only enabled items, zero-stock ones included. Disabled items return 404 on the detail endpoint. Another outlet's menu returns 403.
7. Lock check: in `psql`, `BEGIN; SELECT * FROM outlets WHERE id = '<o>' FOR UPDATE;`, then call the assign endpoint. It waits until you `ROLLBACK`.

### Inventory API

Stock lives in `outlet_menu_items.stock_quantity`: one current balance per outlet assignment. There is no inventory or movement table, so **adjustments are not recorded as history**. Only the resulting balance is stored.

| Method  | Path                                              | Access                                     |
| ------- | ------------------------------------------------- | ------------------------------------------ |
| `GET`   | `/outlets/:outletId/inventory`                    | HQ admin; staff with access to that outlet |
| `GET`   | `/outlets/:outletId/inventory/:menuItemId`        | HQ admin; staff with access to that outlet |
| `PATCH` | `/outlets/:outletId/inventory/:menuItemId/adjust` | `HQ_ADMIN`                                 |

**Response (`InventoryItem`):**

- **Identity:** `outletId`, `menuItemId`, `sku`, `name`.
- **Stock:** `stockQuantity` and `stockStatus`.
- **Sales status:** `isActive` (the assignment), `outletIsActive`, `menuItemIsActive`, `isEnabled`, `isSellable`.
- **`updatedAt`**.
- The serializer reuses the outlet-menu mapping, so availability is calculated in one place.

**Stock status** uses one fixed threshold, `LOW_STOCK_THRESHOLD = 10` in `inventory.validation.ts`:

| Status         | Quantity     |
| -------------- | ------------ |
| `OUT_OF_STOCK` | 0            |
| `LOW`          | 1–10         |
| `IN_STOCK`     | more than 10 |

Stock status is separate from sales availability. An inactive item holding 100 units is `IN_STOCK` but not sellable.

**Listing:**

- Same `page`/`limit` contract as other lists.
- `search` matches SKU or name.
- `status` filters by assignment status.
- `stockStatus` is `all`, `out_of_stock`, `low` or `in_stock`.
- `sortBy` is `sku`, `name`, `stockQuantity` or `updatedAt`, with `menuItemId` as the tie-breaker.
- Everything, including the staff restriction, is part of the Prisma `where` for both items and count.

**Access:**

- **Staff:** see only enabled items in their active outlets, zero stock included. They get 403 for an outlet they don't belong to, and 404 for disabled items.
- **HQ admins:** see everything, including inactive outlets, assignments and master items.

#### Adjustments

```json
{ "operation": "INCREASE", "quantity": 20 }
{ "operation": "DECREASE", "quantity": 15 }
{ "operation": "SET", "quantity": 40, "expectedStockQuantity": 50 }
```

**Validation:**

- Quantities are JSON integers. Strings, fractions, negatives and values above `2147483647` (PostgreSQL `INTEGER`) are rejected.
- `INCREASE`/`DECREASE` need a quantity of 1 or more. `SET` accepts 0 or more.
- `SET` **requires** `expectedStockQuantity`; the other operations **reject** it. Unknown fields, including any client-calculated result, are rejected.

**Response:** `{ inventoryItem, operation, previousStockQuantity, newStockQuantity, changed }`. Every value is read inside the adjustment transaction, from the locked row.

| Result                                                                      | Status / code                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Adjusted, or a `SET` to the current value (no write, `updatedAt` unchanged) | 200                                                            |
| Outlet or assignment not found (an assignment is never created implicitly)  | 404                                                            |
| Outlet inactive                                                             | 409 `OUTLET_INACTIVE`                                          |
| `expectedStockQuantity` doesn't match the locked balance                    | 409 `STOCK_CHANGED` (the message includes the current balance) |
| The result would go below 0                                                 | 409 `INSUFFICIENT_STOCK`                                       |
| The result would exceed 2147483647                                          | 409 `STOCK_LIMIT_EXCEEDED`                                     |
| Transaction aborted twice by a serialization failure or deadlock            | 409 `CONCURRENT_UPDATE`                                        |

- Inactive assignments and inactive master items **can** be corrected, provided the outlet is active.
- Adjusting never touches prices, assignment status, the master item, receipt counters or sales.

#### Transaction and concurrency strategy

The adjustment runs in one Read Committed transaction:

1. `users FOR SHARE`: the acting user must still be an active `HQ_ADMIN`.
2. `outlets FOR SHARE`: the outlet must exist and be active.
3. `outlet_menu_items FOR UPDATE` on `(outlet_id, menu_item_id)`: `stock_quantity` is read **from this locked row**.
4. Check `SET`'s `expectedStockQuantity` against the locked value, then compute the new balance and check the range.
5. `UPDATE … SET stock_quantity = $new`. No other column is written.
6. Return previous and new values, and commit. Any error rolls everything back.

**Why there are no lost updates:**

- The assignment row lock serializes every writer of that row: other adjustments, future sale deductions, and price or status edits.
- A second concurrent adjustment blocks on `FOR UPDATE` until the first commits. It then reads the **committed** balance (Read Committed re-reads the locked row), so two `+5` adjustments from 10 end at 20.
- For two `−7` adjustments from 10, the second sees 3 and gets 409 `INSUFFICIENT_STOCK`.
- No value read outside the transaction is ever used to compute an update.
- `CHECK (stock_quantity >= 0)` from the business migration remains the final safety net.

**Interaction with other operations:**

- **Outlet deactivation** (`UPDATE outlets`) waits for the `FOR SHARE` lock, or is seen first, in which case the adjustment gets 409.
- **Membership changes** don't affect admin adjustments.
- **Price and status edits** on the same assignment serialize on the row lock and write disjoint columns.

**Retries:**

- PostgreSQL may abort a transaction with a serialization failure or deadlock (Prisma `P2034`). Nothing was applied in that case, so the service retries **once on the server**, with a fresh transaction re-reading the locked balance.
- Other failures are not retried.
- The client must never replay an `INCREASE` or `DECREASE` after an ambiguous failure, such as a timeout or network drop. They are **not idempotent**, and re-sending could double-apply. Re-read the balance, or use `SET` with `expectedStockQuantity`, which is safe to retry.
- Deadlocks are unlikely, given the global lock order, but not impossible.

**Phase 6 sales** use the same protocol: after the cashier `users` and `outlets` locks and the receipt counter, they lock each line's assignment `FOR UPDATE` in `menu_item_id` order, check `stock_quantity >= quantity`, then decrement in the same transaction.

**Testing:**

- `tests/unit/inventory.test.ts` covers HTTP behavior: scoping, isolation, the validation matrix, every 409 code, and the single P2034 retry.
- `tests/unit/inventory-repository.test.ts` covers threshold boundaries, the balance maths including `MAX`, the exact lock order, the stock-only update, the no-op `SET`, refusals without writes, and rollback propagation.
- These use mocked Prisma and **do not prove PostgreSQL locking**; see below.

#### Manual PostgreSQL verification (do not run without approval; use disposable records)

1. **Concurrent increases:** set stock to 10 via `SET`. Send two `{"operation":"INCREASE","quantity":5}` requests simultaneously (two terminals, or `xargs -P2`). Final stock is 20.
2. **Concurrent decreases:** from 10, send two simultaneous `DECREASE 7`. One returns 200 and one returns 409 `INSUFFICIENT_STOCK`. Final stock is 3.
3. **Stale SET:** read stock (for example 3), adjust it by `INCREASE 1`, then `SET` with `expectedStockQuantity: 3` → 409 `STOCK_CHANGED`.
4. **Competing with outlet deactivation:** in `psql`, `BEGIN; UPDATE outlets SET is_active = false WHERE id = '<o>';`, then call adjust; it blocks. `COMMIT` → the request returns 409 `OUTLET_INACTIVE`. Repeat with `ROLLBACK` → it succeeds.
5. **Database safety net:** `UPDATE outlet_menu_items SET stock_quantity = -1 WHERE …` fails with `outlet_menu_items_stock_quantity_nonnegative`.
6. **Failure leaves the balance alone:** a rejected adjustment leaves `stock_quantity` unchanged.
7. **No side effects:** after adjustments, `override_price`, `is_active`, `menu_items.*`, `receipt_counters` and `sales` are unchanged.

### Sales API (POS and receipts)

Endpoints are nested under an outlet: `/api/v1/outlets/:outletId/sales`.

| Method | Path                                             | Access                                              |
| ------ | ------------------------------------------------ | --------------------------------------------------- |
| `POST` | `/outlets/:outletId/sales`                       | `OUTLET_STAFF` member of the **active** outlet      |
| `GET`  | `/outlets/:outletId/sales`                       | HQ admin (any outlet); staff (their active outlets) |
| `GET`  | `/outlets/:outletId/sales/by-request/:requestId` | the originating cashier only                        |
| `GET`  | `/outlets/:outletId/sales/:saleId`               | HQ admin; staff of that active outlet               |

The `by-request` route is registered before `/:saleId`.

- **HQ admins are read-only** for sales in this phase.
- **Staff restriction in the database:** every staff read carries the restriction in the Prisma `where` (outlet active and caller a member), for both the page and the count.
- **No cross-outlet lookups:** details are looked up by **both** `outletId` and `saleId`, so a sale id from another outlet returns 404.

#### Request

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "items": [
    { "menuItemId": "…", "quantity": 2, "expectedUnitPrice": "250.00" },
    { "menuItemId": "…", "quantity": 3, "expectedUnitPrice": "100.00" }
  ]
}
```

**Validation:**

- `requestId` and `menuItemId` must be UUIDs, normalized to lowercase.
- 1–100 entries.
- Quantities are JSON integers from 1 to 2147483647.
- `expectedUnitPrice` uses the money contract.
- Bodies are strict: ids, totals, line totals, names, receipt numbers, cashier and timestamps from the client are rejected.

**Normalization** (`sale-calculation.ts`):

- Entries for the same item are combined.
- The same item with different expected prices returns 400.
- A combined quantity above `INTEGER` returns 400.
- Lines are sorted by `menuItemId`.

#### Response

`{ sale, replayed }`, with HTTP **201** for a new sale and **200** for an idempotent replay.

- **Sale fields:** `id`, `outletId`, `outletCode`, `outletName`, `receiptNumber`, `receiptCode`, `requestId`, `createdById`, `totalAmount`, `createdAt`, and `items[] { menuItemId, itemName, quantity, unitPrice, lineTotal }`.
- **`receiptCode`** is derived, not stored: `<outlet code>-<receipt number padded to 6>`, for example `MIRPUR-01-000101`. Numbers above 999999 are never truncated.
- **`requestHash` is never returned.**
- **History items** are compact: `{ id, receiptNumber, receiptCode, totalAmount, lineCount, unitCount, createdById, createdAt }`. `lineCount` is the number of distinct items, and `unitCount` is the sum of quantities, read with one bounded `groupBy` for the page.

**History filters:**

- Pagination.
- `search`: a receipt number or code, such as `101` or `MIRPUR-01-000101`, matched exactly on the number.
- `from`/`to` (ISO with offset): a half-open range `created_at >= from AND created_at < to`, at most 366 days, the same convention as the reports.
- `sortBy`: `createdAt`, `receiptNumber` or `totalAmount`, with `id` as the tie-breaker.

#### Transaction (one Read Committed interactive transaction)

1. `users FOR SHARE` for the cashier. Re-check that the account is active, the **current** role is `OUTLET_STAFF`, and an `outlet_memberships` row exists.
   - Staff deactivation (`UPDATE users`) and membership replacement (`users FOR UPDATE`) conflict with this lock. A revocation therefore either waits for the sale or is seen by it, and is never applied halfway through.
2. `outlets FOR SHARE`. The outlet must exist and be active (`OUTLET_INACTIVE`).
3. `receipt_counters FOR UPDATE` for that outlet.
   - This serializes sales **per outlet only**; other outlets proceed in parallel.
   - A missing counter is a 500 `RECEIPT_COUNTER_MISSING` and is never silently recreated.
4. **Idempotency check** under the counter lock: look up `(outlet_id, request_id)`.
   - Same cashier and same `request_hash`: return the original sale. Nothing else runs.
   - Different hash, or another cashier's request: `IDEMPOTENCY_CONFLICT`, which reveals nothing about the other sale.
   - This runs before any price or stock check, so a replay still succeeds after the original sale emptied the stock or a price changed.
5. Assignments `FOR UPDATE` for every line, in **one** `ORDER BY menu_item_id` query. Stock and `override_price` are read from the locked rows.
6. Master items `FOR SHARE`, in one `ORDER BY id` query. Name, `base_price` and `is_active` are read from the locked rows.
7. Validate every line **before any write**:
   - unassigned, inactive assignment or inactive master item → `ITEM_UNAVAILABLE`;
   - `override_price ?? base_price` different from `expectedUnitPrice` → `PRICE_CHANGED`;
   - not enough stock → `INSUFFICIENT_STOCK`.
   - Each error includes `errors[].meta` with `menuItemId` and `currentUnitPrice` or `availableQuantity`.
8. Exact totals (below). Limits: `SALE_TOTAL_LIMIT_EXCEEDED`, and `RECEIPT_LIMIT_EXCEEDED` when `last_number = 2147483647`.
9. Deduct stock with guarded updates, `UPDATE … SET stock_quantity = stock_quantity − q WHERE outlet_id = $o AND menu_item_id = $m AND stock_quantity >= q`. Each must affect exactly 1 row, or the transaction throws. `CHECK (stock_quantity >= 0)` is the final safety net.
10. `UPDATE receipt_counters SET last_number = last_number + 1 … RETURNING last_number` gives the receipt number.
11. `INSERT` the sale (server cashier id, receipt number, request id, hash and total), then `createMany` sale lines with the composite keys `(sale_id, outlet_id)` and `(outlet_id, menu_item_id)`, plus the name and price snapshot.
12. Commit. The response is read back only **after** commit.

**Rollback guarantees:**

- Business refusals return before any write, so nothing is left behind.
- Any thrown error in steps 9–11 aborts the whole transaction: stock, counter, sale and lines.
- Because the counter is incremented inside the same transaction, **a failed sale never consumes a receipt number**, and numbers are gap-free within an outlet.
- Receipt numbers never come from `MAX()+1`, `COUNT()`, timestamps, memory or a global sequence.

**Retries (service):**

- Only for Prisma `P2034`, a serialization failure or deadlock where PostgreSQL rolled the transaction back. Up to 3 attempts with a short back-off, using the same `requestId` and hash.
- A `P2002` race on `(outlet_id, request_id)` is retried once and resolves as a replay.
- Exhausting the attempts gives 409 `CONCURRENT_UPDATE`.
- Errors where the commit outcome is unknown, such as a dropped connection, are **not** retried. The client resolves them with idempotent replay or the `by-request` endpoint.
- Consistent lock ordering reduces deadlocks but does not rule them out.

#### Exact money

- Prices are read from PostgreSQL as text (`::text`) and parsed strictly as `^\d{1,14}\.\d{2}$`. `NaN` or any malformed value throws and rolls back.
- Arithmetic uses **BigInt minor units**. Prisma's `Decimal` (decimal.js) defaults to 20 significant digits, which a 12-digit price × 10-digit quantity can exceed, so it is not used for multiplication.
- Unit prices must stay within `DECIMAL(12,2)`. Line totals and the sale total must stay at or below `99999999999999.99` (`DECIMAL(16,2)`).
- The service asserts that the total equals the sum of the lines.
- All amounts are returned as two-decimal strings. The currency is BDT.

#### Snapshots and immutability

- Sale lines store `item_name`, `unit_price` and `line_total`, so receipts never use current catalog prices.
- There is no update or delete endpoint for sales.
- `outletName` is **not** snapshotted (the schema has no column for it), so historical receipts show the outlet's current name. The outlet `code` is immutable.

#### Concurrency verification (real PostgreSQL)

`scripts/verify-sales-concurrency.ts` runs the real services and repositories against a **disposable, local** PostgreSQL. The shared guard in `scripts/support/disposable-database.ts` refuses to start unless:

- `SALES_VERIFICATION_DATABASE_URL` is set and `CONFIRM_DISPOSABLE_DATABASE=yes`;
- the host is `localhost`, `127.0.0.1` or `::1` (remote and shared databases are always refused);
- the database name contains `test`, `verify`, `verification`, `disposable` or `scratch`;
- host aliases, port and database name do not resolve to the configured `DATABASE_URL`;
- after connecting, `current_database()` matches and the database contains no users or outlets that the scripts did not create (fixture users use `@example.invalid`, fixture outlets `VERIFY-`).

```bash
# 1. Start a throwaway local PostgreSQL 18. Never point this at the shared database.
docker run --rm -d --name outlethub-verify -e POSTGRES_PASSWORD=verify -p 55432:5432 postgres:18
export VERIFY_URL=postgresql://postgres:verify@localhost:55432/outlethub_verify
createdb -h localhost -p 55432 -U postgres outlethub_verify
# 2. Apply migrations to it:
DATABASE_URL=$VERIFY_URL pnpm db:migrate:deploy
# 3. Run the scenarios:
SALES_VERIFICATION_DATABASE_URL=$VERIFY_URL CONFIRM_DISPOSABLE_DATABASE=yes pnpm verify:sales-concurrency
```

| Scenario                       | Setup                                                                    | Expected                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| A. Overselling                 | stock 10, two concurrent sales of 7                                      | one OK and one `INSUFFICIENT_STOCK`; stock 3; counter +1; 1 sale                              |
| B. Concurrent valid sales      | stock 20, ten concurrent sales of 1                                      | all OK; stock 10; receipts 1..10, consecutive                                                 |
| C. Concurrent idempotency      | same request id × 10                                                     | all ten succeed; exactly 1 created and 9 replays; one sale id; stock and counter changed once |
| D. Multi-item atomicity        | one line short of stock                                                  | nothing changes (stock, counter, sales, lines)                                                |
| E. Independent outlets         | 5 + 5 concurrent sales in two outlets                                    | each counter is 5; stock changes stay per outlet                                              |
| F. Sale vs. stock adjustment   | sell 4 while an admin adds 5, from 10                                    | 11 (no lost update)                                                                           |
| G. Sale vs. price change       | sell while the base price changes and the override is cleared            | either committed at the old price or `PRICE_CHANGED` with stock untouched                     |
| H. Sale vs. membership removal | sell while the cashier's memberships are replaced with `[]`              | either committed before, or `AUTHORIZATION_ERROR`; membership gone                            |
| I. Injected failure            | real `SaleRepository`; the client proxy makes `saleItem.createMany` fail | stock, counter, `Sale` and `SaleItem` rows unchanged (no production flag)                     |

Scenario I wraps the Prisma client in a script-local `Proxy` whose interactive transaction rejects `saleItem.createMany`, so the unmodified production `SaleRepository` deducts stock, increments the counter and inserts the `Sale` before failing. There is no failure-injection flag in application code.

The script prints PASS or FAIL per check and exits non-zero on any failure. **It has been executed on a disposable local PostgreSQL 18: 34/34 checks passed**, including two extra races (G2: assignment disabled mid-sale; H2: cashier deactivated mid-sale). See [docs/VERIFICATION.md](docs/VERIFICATION.md). The unit tests (`sale-calculation`, `sales`, `sale-repository`) use mocks: they prove the orchestration (lock order, writes only after validation, no writes on replay or refusal, errors propagating from every write step), **not** PostgreSQL's locking or atomicity.

#### Comparison with the documented design

- **Same lock order as planned:** user → outlet → receipt counter → assignments → master items, as in the ERD and flowchart and the earlier "future sale" notes.
- **Idempotency lookup placement:** runs _after_ the counter lock rather than before the transaction. This serializes duplicate submissions of the same request id, so they cannot both pass the lookup.
- **No structural schema changes.**

### Reports API (HQ_ADMIN only)

All endpoints require `HQ_ADMIN`. `OUTLET_STAFF` gets `403` and anonymous requests get `401`.

| Method | Path                                                  | Purpose                                              |
| ------ | ----------------------------------------------------- | ---------------------------------------------------- |
| GET    | `/api/v1/reports/summary`                             | Company revenue, sale count, units and outlet counts |
| GET    | `/api/v1/reports/revenue-by-outlet`                   | Paginated revenue per outlet                         |
| GET    | `/api/v1/reports/outlets/:outletId/top-selling-items` | Top 5 items of one outlet by quantity                |

#### Date range

- `from` and `to` are optional ISO 8601 timestamps **with an offset** (`Z` or `+06:00`). Send both or neither. Neither means all sales.
- The range is half-open: `created_at >= from AND created_at < to`. Clients send the next local midnight as `to`, never `23:59:59`.
- Rejected with `400`: one bound only, an invalid timestamp or one without an offset, `to <= from`, or a span longer than 366 days. Unknown query parameters are also rejected.
- Outlet counts (`totalOutlets`, `activeOutlets`) and outlet `isActive` are **current** values, not historical.

#### Responses

```json
// GET /reports/summary
{ "totalRevenue": "148500.00", "totalSales": "594", "totalUnitsSold": "1248", "totalOutlets": 5, "activeOutlets": 4 }

// GET /reports/revenue-by-outlet?page=1&limit=20
{ "items": [{ "outletId": "…", "outletCode": "MIRPUR-01", "outletName": "Mirpur", "isActive": true,
              "totalRevenue": "80500.00", "totalSales": "312" }],
  "pagination": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 } }

// GET /reports/outlets/:outletId/top-selling-items
{ "outlet": { "id": "…", "code": "MIRPUR-01", "name": "Mirpur", "isActive": true },
  "items": [{ "rank": 1, "menuItemId": "…", "sku": "BURGER-001", "name": "Classic Burger",
              "quantitySold": "420", "totalRevenue": "105000.00" }] }
```

- **Revenue by outlet** lists every outlet, including inactive ones and outlets without sales (`"0.00"`, `"0"`). `search` (≤ 100 characters) matches the code or name with `ILIKE`, escaping `%`, `_` and `\`. `sortBy` is `totalRevenue` (default), `totalSales` or `code`, and `sortOrder` defaults to `desc`. `o.id ASC` always breaks ties. Sorting happens in PostgreSQL on the numeric values.
- **Top-selling items** returns `404` for an unknown outlet and allows inactive outlets. Items are grouped by `menu_item_id`, ordered by `SUM(quantity) DESC, menu_item_id ASC`, and limited to 5. Revenue is `SUM(line_total)`, so the same item sold at different prices is exact. The `sku` and `name` labels come from the **current** master item, while `sale_items.item_name` keeps the historical receipt text.

#### Money and counts

- Aggregation stays in PostgreSQL `NUMERIC` (`SUM(total_amount)`, `SUM(line_total)`) and is returned as text. It is **not** cast back to `DECIMAL(16,2)`, so company-wide totals have no upper bound.
- `serializeAggregateMoney` normalizes to exactly two decimals (`"12.5"` → `"12.50"`). `AggregateMoney` in OpenAPI has no maximum. Any other text, such as `NaN`, a negative or a third decimal, throws. The client gets a generic `500`, never a wrong figure. (The pending `money_not_nan` migration will block NaN at write time; it is still **not applied**.)
- Sale counts and unit totals are integer strings (`^\d+$`), safe beyond 2^53. Outlet counts are JSON integers.
- The currency is BDT.

#### Query strategy

| Endpoint          | Queries (one snapshot)                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Summary           | ① `SUM(total_amount), COUNT(*)` on `sales`; ② `SUM(quantity)` on `sale_items JOIN sales ON (id, outlet_id)`; ③ `COUNT(*)`, `COUNT(*) FILTER (WHERE is_active)` on `outlets` |
| Revenue by outlet | `outlets LEFT JOIN (SELECT outlet_id, SUM, COUNT FROM sales WHERE <range> GROUP BY outlet_id)` + `COALESCE`, `ORDER BY … , o.id LIMIT/OFFSET`; plus a count                 |
| Top-selling items | outlet lookup; `sale_items JOIN sales ON (sale_id, outlet_id) JOIN menu_items … GROUP BY menu_item_id ORDER BY SUM(quantity) DESC, menu_item_id LIMIT 5`                    |

- **No join multiplication.** Revenue and sale count come from `sales` alone. Units come from a separate `sale_items` aggregate. The date filter sits _inside_ the outlet subquery, so the `LEFT JOIN` keeps zero-sale outlets.
- **Parameterized raw SQL.** Queries use Prisma tagged templates. Every value, including dates, outlet id, search, limit and offset, is a bind parameter. `Prisma.raw` appears only for allowlisted constant `ORDER BY` fragments and column names. There is no `SELECT *` and no N+1.
- **Consistent snapshot, no locks.** Each endpoint's queries run as one batched transaction at `REPEATABLE READ`, so all figures come from the same MVCC snapshot. Reads never block POS writers, and no `FOR UPDATE`/`FOR SHARE` is taken.
- **Indexes used:** `sales(outlet_id, created_at)` for per-outlet ranges and grouping, the `sales` primary key and `(id, outlet_id)` unique for the `sale_items` join, `sale_items(outlet_id, menu_item_id)` for top-selling, and the `sale_items` primary key `(sale_id, menu_item_id)`. A company-wide range filter without an outlet scans `sales`. If data volume grows, a `sales(created_at)` index is the next candidate. It is **not** added now.
- `EXPLAIN ANALYZE` was **not** run against the shared database. Run it only on a disposable copy.

#### Reporting verification (real PostgreSQL)

`scripts/verify-reports.ts` uses the same disposable-database guard as the concurrency script, with `REPORTS_VERIFICATION_DATABASE_URL`. It creates its own fixtures in March 2099:

- three outlets: one with several multi-item sales, one **inactive** with a sale, and one with **no sales**;
- seven items, more than five, with three-way and two-way **quantity ties**;
- the **same item at two prices** (`10.00` and `12.50`);
- an item **renamed** after it was sold;
- sales exactly at `from` (included), exactly at `to` (excluded) and 1 ms before `from` (excluded).

It then checks the report outputs:

- window totals: `339.00`, `4` sales and `26` units;
- current outlet counts;
- the all-time delta of `489.00` over `6` sales;
- zeros for an empty range;
- revenue-by-outlet order, statuses, zero rows, sorting and pagination;
- top-5 ranks with id tie-breaks, exact line-total sums and current labels;
- the inactive outlet, the no-sales outlet and an unknown outlet.

```bash
REPORTS_VERIFICATION_DATABASE_URL=$VERIFY_URL CONFIRM_DISPOSABLE_DATABASE=yes pnpm verify:reports
```

**Executed on a disposable local PostgreSQL 18: 18/18 checks passed, and passed again on a second run against the same database.** Each run picks a random future month and refuses to seed unless that month (±1 day) contains no sales, so repeated runs cannot contaminate each other. The unit tests (`reports`, `report-repository`, `disposable-database`) are mocked. They prove validation, authorization, SQL shape (joins, half-open filter, tie-breaks, parameter binding), serialization and the guard's refusals, but **not** PostgreSQL's results.

## Database Schema

PostgreSQL holds ten tables, defined in [`prisma/schema.prisma`](prisma/schema.prisma) and created only through the committed SQL migrations in `prisma/migrations/`. The full diagram is in [erd-diagram.pdf](erd-diagram.pdf), and [docs/ARCHITECTURE.md §4](docs/ARCHITECTURE.md#4-data-model) explains the design.

| Table                | Purpose                                                                         | Key constraints                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`              | HQ administrators and outlet staff (`role`: `HQ_ADMIN` or `OUTLET_STAFF`)       | `email` unique; Argon2id `password_hash`; `is_active` index                                                                                                                                                                                                                       |
| `refresh_sessions`   | Rotating refresh tokens, stored only as SHA-256 hashes and grouped in families  | `token_hash` unique; FK to `users` with `ON DELETE CASCADE`; revoke reason enum (`LOGOUT`, `ROTATED`, `REPLAY_DETECTED`, `ADMIN_REVOKED`, `EXPIRED`)                                                                                                                              |
| `outlets`            | Physical outlets                                                                | `code` unique; `CHECK` that code and name are not blank                                                                                                                                                                                                                           |
| `outlet_memberships` | Which staff may work at which outlet                                            | Composite PK `(user_id, outlet_id)`; index on `outlet_id`                                                                                                                                                                                                                         |
| `receipt_counters`   | One gap-free receipt sequence per outlet, created with the outlet               | PK = `outlet_id`; `CHECK (last_number >= 0)`                                                                                                                                                                                                                                      |
| `menu_items`         | Master menu shared by all outlets                                               | `sku` unique; `CHECK` that SKU and name are not blank; `base_price DECIMAL(12,2)`, `CHECK (>= 0)` and `<> 'NaN'`                                                                                                                                                                  |
| `outlet_menu_items`  | An outlet's assignment of a master item: optional override price, stock, status | Composite PK `(outlet_id, menu_item_id)`; `CHECK (stock_quantity >= 0)`; override `NULL` or `>= 0` and not NaN                                                                                                                                                                    |
| `sales`              | One completed sale (receipt)                                                    | Unique `(outlet_id, receipt_number)`, `(outlet_id, request_id)` and `(id, outlet_id)`; `CHECK (receipt_number > 0)`; `total_amount DECIMAL(16,2)`, `>= 0` and not NaN; `request_hash` must be SHA-256 hex; index `(outlet_id, created_at)`                                        |
| `sale_items`         | Immutable line snapshots: item name, unit price, line total                     | PK `(sale_id, menu_item_id)`; composite FKs `(sale_id, outlet_id) → sales(id, outlet_id)` and `(outlet_id, menu_item_id) → outlet_menu_items`; `CHECK (quantity > 0)`, `CHECK (line_total = unit_price * quantity)`, prices `>= 0` and not NaN; index `(outlet_id, menu_item_id)` |
| `_prisma_migrations` | Prisma's migration history                                                      | Managed by Prisma                                                                                                                                                                                                                                                                 |

**Design points:**

- **Effective price** = `outlet_menu_items.override_price` if set, otherwise `menu_items.base_price`.
- **Outlet isolation in the database:** the two composite foreign keys on `sale_items` share `outlet_id`, so a sale line can never reference another outlet's sale or assignment.
- **Snapshots:** sale lines copy the name and prices, so receipts never change when the menu does.
- **History is protected:** business relations use `ON DELETE RESTRICT`, sale relations also use `ON UPDATE RESTRICT`, and no endpoint deletes business data.
- **Exact money:** prices are `DECIMAL(12,2)` and totals `DECIMAL(16,2)`. `NaN` is rejected by the `money_not_nan` migration.

```mermaid
erDiagram
    users ||--o{ refresh_sessions : "has"
    users ||--o{ outlet_memberships : "is assigned"
    outlets ||--o{ outlet_memberships : "has staff"
    outlets ||--o| receipt_counters : "numbers receipts"
    outlets ||--o{ outlet_menu_items : "offers"
    menu_items ||--o{ outlet_menu_items : "is assigned as"
    outlets ||--o{ sales : "records"
    users ||--o{ sales : "creates"
    sales ||--|{ sale_items : "contains"
    outlet_menu_items ||--o{ sale_items : "is sold as"

    users {
        uuid id PK
        varchar email UK
        varchar password_hash
        Role role
        boolean is_active
        timestamptz created_at
        timestamptz updated_at
    }
    refresh_sessions {
        uuid id PK
        uuid family_id
        char token_hash UK
        uuid user_id FK
        timestamptz expires_at
        timestamptz revoked_at
        SessionRevokeReason revoke_reason
        varchar user_agent
        inet ip_address
        timestamptz created_at
        timestamptz last_used_at
    }
    outlets {
        uuid id PK
        varchar code UK
        varchar name
        varchar address
        boolean is_active
        timestamptz created_at
        timestamptz updated_at
    }
    outlet_memberships {
        uuid user_id PK, FK
        uuid outlet_id PK, FK
        timestamptz created_at
    }
    receipt_counters {
        uuid outlet_id PK, FK
        int last_number
    }
    menu_items {
        uuid id PK
        varchar sku UK
        varchar name
        varchar description
        decimal base_price
        boolean is_active
        timestamptz created_at
        timestamptz updated_at
    }
    outlet_menu_items {
        uuid outlet_id PK, FK
        uuid menu_item_id PK, FK
        decimal override_price
        int stock_quantity
        boolean is_active
        timestamptz created_at
        timestamptz updated_at
    }
    sales {
        uuid id PK
        uuid outlet_id FK
        uuid created_by_id FK
        int receipt_number
        uuid request_id
        char request_hash
        decimal total_amount
        timestamptz created_at
    }
    sale_items {
        uuid sale_id PK, FK
        uuid outlet_id FK
        uuid menu_item_id PK, FK
        varchar item_name
        int quantity
        decimal unit_price
        decimal line_total
    }
```

The diagram shows each relationship once. In the database, `sale_items` reaches `sales` through `(sale_id, outlet_id)` and `outlet_menu_items` through `(outlet_id, menu_item_id)`.

## Architecture

This is a summary. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the full design and [flowchart-diagram.pdf](flowchart-diagram.pdf) the business workflow.

**Layers.** The backend is a modular monolith: one deployable Express 5 process, organized by business module. Every module follows the same request path:

```text
route (middleware + validation) → controller (HTTP only) → service (business rules, errors, retries) → repository (Prisma, transactions, row locks, raw SQL)
```

**Middleware**, in order:

1. request id;
2. pino HTTP logging with redaction;
3. helmet;
4. exact-origin CORS (`GET`, `POST`, `PATCH`, `PUT`, with credentials);
5. global rate limit;
6. request timeout;
7. JSON body limit;
8. cookie parser;
9. then per route: `authenticate`, `authorize(role)`, `requireOutletAccess`, `validate({ body, query, params })`;
10. finally `notFound` and a central `errorHandler`.

**Authentication and outlet authorization:**

- **Access tokens:** short-lived JWTs (15 minutes by default) with issuer and audience checks. `authenticate` reloads the user on every request, so deactivation takes effect immediately.
- **Refresh tokens:** opaque, rotating, stored as SHA-256 hashes. Reusing a rotated token revokes the whole family. They travel in an httpOnly `SameSite=Strict` cookie scoped to `/api/v1/auth`.
- **Roles:** `authorize` enforces `HQ_ADMIN` or `OUTLET_STAFF`.
- **Outlet access:** HQ can reach any existing outlet; staff need an active membership of an active outlet.

**The sale transaction:**

- **Global lock order:** `POST /outlets/:outletId/sales` runs one `READ COMMITTED` transaction that locks rows in the order every module uses:

  ```text
  users → outlets → receipt_counters → outlet_menu_items (by menu_item_id) → menu_items (by id)
  ```

- **Idempotency:** the `(outlet_id, request_id)` lookup runs after the receipt-counter lock, so concurrent duplicate submissions cannot both create a sale.
- **Validation:** prices and availability are checked against the locked rows.
- **Writes:** stock is deducted with guarded updates, the counter is incremented, and the sale and its line snapshots are inserted. Any failure rolls back all of it.
- **Isolation levels elsewhere:** refresh-token rotation uses `SERIALIZABLE`. Each report endpoint reads one `REPEATABLE READ` snapshot without locks.
- **Time zone:** every database session is pinned to UTC.

**Source layout:**

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
│   ├── inventory/          # outlet stock balances and adjustments
│   ├── menu-items/         # master menu (HQ only)
│   ├── outlet-menu-items/  # outlet menu assignments and price overrides
│   ├── outlets/            # outlet management
│   ├── reports/            # revenue reporting (HQ only)
│   ├── sales/              # POS sales, receipts, idempotency
│   └── staff/              # staff accounts and outlet memberships
├── routes/                 # versioned route composition
├── app.ts                  # side-effect-free Express factory
└── server.ts               # process and server lifecycle
prisma/
├── migrations/             # immutable SQL migration history
├── schema.prisma           # full domain schema
├── seed.ts                 # explicitly invoked HQ administrator seed
└── seed-demo.ts            # idempotent, namespaced demo data
scripts/                    # real-PostgreSQL verification, audit, demo login checks
docs/                       # ARCHITECTURE.md, VERIFICATION.md
tests/unit/                 # database-independent unit tests
```

Controllers only translate HTTP input and output. Services hold business rules without Express types. Repositories own all Prisma access, transactions and row locks.

## Scaling Strategy

The question: how would OutletHub support **10 outlets and 100,000 transactions per month**?

The section separates three kinds of statement: what is **implemented**, what was **measured**, and what is **proposed**. The full reasoning is in [docs/ARCHITECTURE.md §9](docs/ARCHITECTURE.md#9-scaling-plan-10-outlets-and-100000-transactions-per-month-proposal), and the measurements are in [docs/VERIFICATION.md](docs/VERIFICATION.md).

**Load in numbers:**

- 100,000 sales a month is about 3,300 a day, or about 0.04 per second on average.
- An evening peak of about 10× the average is still under one sale per second across the company, and far lower per outlet.

**Measured:**

- On a synthetic dataset of **100,000 sales, 250,000 sale lines and 10 outlets** in a disposable PostgreSQL 18, every reporting and listing query ran in **≤ 23 ms**.
- PostgreSQL 18 answered a company-wide 1-day summary in **1.7 ms** by skip-scanning the existing `(outlet_id, created_at)` index.
- From a remote client to the configured database, a round trip took about **160 ms**. A sale costs 15–20 round trips, so roughly **3 s** remotely; running the API next to the database removes most of that.
- **No sustained load test was run**, so no throughput figure is claimed.

**Conclusion:** the current single database and modular monolith comfortably fit this target. Everything below is a **proposal**, to adopt when a measured metric requires it.

### a. Database scaling

- **Connection pooling.** _Implemented:_ each API instance has a bounded pool (`DATABASE_POOL_MAX`). _Proposal:_ keep `instances × pool` below `max_connections` minus headroom. Add PgBouncer in transaction mode only when the instance count grows. The session-level UTC pin would then move to the database or role setting.
- **Indexing.** _Implemented and measured:_ the indexes on `sales (outlet_id, created_at)`, `sale_items (outlet_id, menu_item_id)` and the unique and primary keys cover every hot path. _Proposal:_ find real slow queries with `pg_stat_statements` and `EXPLAIN (ANALYZE, BUFFERS)` on a production-sized copy. Add `sales (created_at)` only if company-wide range reports become slow.
- **Partitioning `sales` by month.** _Proposal:_ range-partition `sales` and `sale_items` by month once the tables reach tens of millions of rows, or when archiving needs cheap partition detach. About 1.2 million sales a year does not need it yet. Partitioning would also require the unique keys to include the partition key.
- **Read replicas.** _Proposal:_ only when report load measurably affects POS latency. Reports served from a replica must show an "as of" time, because of replication lag.
- **Archiving.** _Proposal:_ keep the last 13–24 months hot. Move older months to archive partitions or cold storage, and keep pre-aggregated summaries for long-range reporting.
- **Backups and PITR.** _Proposal:_ continuous WAL archiving with point-in-time recovery, daily base backups and regularly tested restores. A sales ledger needs more than snapshots.
- **Receipt-counter contention.** The counter row lock serializes sales **per outlet** only. At about 50–100 ms of in-region transaction time, that is roughly 10–20 sales per second per outlet (an estimate, not a measurement), far above one till's rate. _Proposal, if ever needed:_ per-terminal receipt series. That would change the gap-free-per-outlet guarantee.

### b. Reporting performance

- **Today:** aggregation runs in PostgreSQL, ranges are index-assisted, each endpoint reads one `REPEATABLE READ` snapshot without locks, and ranges are limited to 366 days.
- **Pre-aggregated daily summaries** (_proposal_): `sales_daily(outlet_id, day, revenue, sale_count, units)` and a per-item daily table. Long ranges then read about 30 rows per outlet per month instead of every sale.
- **Incremental refresh** (_proposal_): either update the summaries in the sale transaction (strictly consistent, slightly longer writes), or refresh asynchronously, for example with a materialized view and `REFRESH MATERIALIZED VIEW CONCURRENTLY` or an incremental job. The asynchronous options are eventually consistent and labelled "as of".
- **Replica-backed reporting** (_proposal_): send report queries to a read replica so they never compete with the POS write path.
- **Caching** (_proposal_): cache closed periods (past days) aggressively, because they never change. Keep "today" short-lived or uncached. On the client, TanStack Query already caches and refetches only on demand or after a sale.
- **Date-range limits** (_implemented_): at most 366 days per request, with half-open `[from, to)` ranges. Longer analysis would use the summaries.

### c. Infrastructure

- **Horizontal API instances** (_proposal_): the API is stateless (sessions live in PostgreSQL), so several instances can run behind Coolify's Traefik load balancer. Readiness uses `/api/v1/health/ready` and liveness `/api/v1/health/live`; both are implemented.
- **Shared rate-limit store** (_proposal_): current limits are in-memory per process. With more than one instance, move them to Redis (or the edge) so limits are global.
- **Health checks** (_implemented_): the Docker `HEALTHCHECK` covers liveness. The readiness endpoint pings the database with a timeout.
- **Monitoring and logging:**
  - _Implemented:_ structured pino JSON logs with request ids and secret redaction.
  - _Proposal:_ ship the logs to a central store.
  - _Proposal:_ alert on route latency percentiles; 5xx rates; `INSUFFICIENT_STOCK`/`PRICE_CHANGED`/`CONCURRENT_UPDATE` rates; pool saturation; lock waits; slow queries; disk and WAL growth.
- **CI/CD:**
  - _Today:_ Husky runs lint-staged and commitlint locally, and Coolify builds from Git.
  - _Proposal:_ a CI pipeline running `pnpm verify`, `security:audit` and the real-database suites against a disposable PostgreSQL before deploy.
- **Migrations strategy:**
  - _Implemented:_ committed, additive SQL migrations applied explicitly (`pnpm db:migrate:deploy`, or the `migrate` Docker stage) **before** deploying code that needs them. Deployments never migrate automatically.
  - _Proposal:_ expand-and-contract changes for zero-downtime deploys, and a separate migration role with DDL rights.

### d. Architectural evolution

1. **Modular monolith (current).** Sale, stock deduction and receipt numbering need one ACID transaction, and a single deployable keeps operations simple.
2. **Events through a transactional outbox** (_proposal_). The sale transaction also writes an `outbox` row, and a relay publishes `SaleCompleted`. Reporting summaries, notifications and a kitchen display consume it idempotently, without lengthening the POS path.
3. **Extract services where a metric demands it** (_proposal_). Reporting is the natural first candidate, because it is read-heavy and tolerates eventual consistency. Sales & Inventory should stay one service with one database.

**When to act:** when an agreed threshold is crossed, for example POS p95 above 300 ms or report p95 above 2 s. Measure first, with route latency percentiles, `pg_stat_statements`, lock-wait monitoring and pool saturation.

### Microservices evolution (summary)

Possible bounded contexts:

- Identity & Access;
- Outlet Management;
- Menu & Pricing;
- **Sales & Inventory** (one service, one database);
- Reporting (event-built read models);
- Notifications/Kitchen.

How they would work together:

- **Data:** each service owns its schema.
- **Communication:** services talk through synchronous calls for current data and events for everything else.
- **Delivery:** a transactional outbox avoids dual writes, idempotent consumers (inbox tables) give at-least-once delivery with effect-once results, and dead-letter queues plus reconciliation jobs handle failures.

Sales, stock deduction and receipt numbering must stay in one transactional boundary. Splitting them would replace today's guarantees (no oversell, gap-free receipts, replay without double deduction) with sagas and compensations. Full proposal: [docs/ARCHITECTURE.md §10](docs/ARCHITECTURE.md#10-microservices-evolution-proposal).

### Offline POS & KDS (summary)

This is a **proposal; it is not implemented**.

- **Local data:** each terminal keeps a catalog and price snapshot and a durable local order store, such as IndexedDB or SQLite.
- **Sync:** each sale gets a client-generated UUID, which is today's `requestId`, so synchronization reuses the server's idempotency. A pending queue syncs with backoff and acknowledgments.
- **Offline sales endpoint:** offline sales need a separate endpoint that records conflicts (stale prices, negative stock) for review instead of rejecting them.
- **Receipt numbers:** strict gap-free per-outlet numbering cannot be guaranteed across disconnected terminals. The options are provisional local receipts, reserved ranges per terminal, or an outlet-local coordinator.
- **Kitchen display:** a kitchen display (KDS) talks to that coordinator over the outlet LAN, with acknowledged, de-duplicated orders and persisted status transitions.

Full proposal: [docs/ARCHITECTURE.md §11](docs/ARCHITECTURE.md#11-offline-pos-and-kds-strategy-proposal-not-implemented).

## Verification

Every executed check, with real results, is in [docs/VERIFICATION.md](docs/VERIFICATION.md). The real-PostgreSQL suites for concurrency and reporting are described under [Sales API](#concurrency-verification-real-postgresql) and [Reports API](#reporting-verification-real-postgresql).

### API integration verification (real HTTP, real PostgreSQL)

`scripts/verify-api-integration.ts` (`pnpm verify:api`) builds the **real Express app** (`createApp`) on a disposable local database behind the same guard. It drives the whole business flow through HTTP with Supertest, using real Argon2id hashes, real JWTs and refresh cookies, real transactions, stock deduction, receipts and report SQL. Nothing is mocked.

The flow:

1. HQ logs in, creates two outlets (receipt counters start at 0), a staff account and memberships.
2. HQ creates three menu items, assigns them, sets overrides (`260` → `"260.00"`, `25.75`) and replenishes stock.
3. Staff logs in, reads the menu, and is refused other outlets (menu, details, sales, inventory) and HQ-only endpoints with 403.
4. Staff completes a multi-item sale (exact `984.50`, receipt `…-000001`, stock 18/2/16). A replay returns 200 with no second deduction; a different payload under the same id gets `IDEMPOTENCY_CONFLICT`. The next sale gets receipt 2.
5. Receipt by id and by request id, history, and the historical name snapshot after a rename.
6. Refusals: `INSUFFICIENT_STOCK` with `meta.availableQuantity`, stale price → `PRICE_CHANGED` with `meta.currentUnitPrice`, cross-outlet sale → 403, HQ sale → 403, disabled assignment and inactive master → `ITEM_UNAVAILABLE`, inactive outlet → refused (counter unchanged). Reports: exact summary delta, revenue by outlet including the zero-sale outlet, top-selling ranks, and a reversed range → 400.
7. Auth: invalid and unknown credentials get the same 401, untrusted Origin → 403, refresh rotates the cookie, the rotated-out token → 401, logout then refresh → 401, deactivated staff cannot log in and their access token is rejected.

```bash
API_VERIFICATION_DATABASE_URL=$VERIFY_URL CONFIRM_DISPOSABLE_DATABASE=yes pnpm verify:api
```

Result: **75/75 checks passed**, on two consecutive runs. This includes a check that sessions run in UTC on a cluster whose server default is `Asia/Dhaka`.

## Known limitations

- **Payments:** no payments, discounts, taxes, refunds or offline POS. A "sale" is a recorded transaction.
- **Rate limits:** in-memory per process; use a shared store before scaling out.
- **Interactive transactions:** they use Prisma's default 5 s timeout. Run the API close to the database; from a remote client (~160 ms round trip) a sale takes about 3 s.
- **Audit trail:** no audit log of stock adjustments (only the current balance is stored).
- **Load:** no sustained load test was run. Query timings come from a 100,000-sale synthetic dataset on a local disposable database; see [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Security considerations

- Helmet sets API-focused security headers, and Express fingerprinting is disabled. CORS and state-changing cookie endpoints use exact origin allowlists. All input is validated.
- Prisma parameterizes queries. Raw SQL (row locks, reports) uses tagged templates with bound parameters. `Prisma.raw` appears only for allowlisted constant fragments.
- Every database session is pinned to `TimeZone=UTC`, because the node-postgres adapter sends `Date` parameters without an offset.
- Use `sslmode=require` with `sslrootcert` for any connection over the internet. Prefer an SSH tunnel or the internal Coolify network over a publicly exposed port. If a port must be exposed, restrict it by IP.
- Credentials exist only in ignored env files or in Coolify's runtime variables. They are never in Git, the build context, or image layers.
- Authorization headers, cookies, passwords, tokens, `DATABASE_URL`, and `JWT_SECRET` are redacted from logs. Production responses hide internal errors.
- The rate-limit store is process-local. Before running multiple replicas, use a shared store such as Redis.
- Keep `replicas × DATABASE_POOL_MAX` for every consumer (local and deployed) below the database's connection limit.
- Swagger UI is forced off in production. Restrict `/openapi.json` at the proxy if the schema must not be public.
- Because the database is shared, treat every developer machine as production-privileged. For anything beyond this assessment, separate the environments.
