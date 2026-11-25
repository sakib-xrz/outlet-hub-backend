# OutletHub Backend

Production-oriented backend foundation for OutletHub, a future multi-outlet POS management system. This repository intentionally contains only platform infrastructure, authentication/session management, health checks, documentation, and engineering tooling. It does **not** contain outlet, menu, inventory, sales, receipt, reporting, or synchronization features.

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
│   ├── auth/               # routes → controller → service → repository
│   └── health/             # liveness and readiness
├── routes/                 # versioned route composition
├── app.ts                  # side-effect-free Express factory
└── server.ts               # process and server lifecycle
prisma/
├── migrations/             # immutable SQL migration history
├── schema.prisma           # authentication models only
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
2. **Application:** add a resource from the Git repository. Use build pack **Dockerfile**, base directory `/backend`, and Dockerfile `Dockerfile` (the final stage, `production`, is the default target). Set the port to `3000`, or whatever `PORT` you set.
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
