# NestJS application — module & test guide

This folder holds TREK's unified NestJS application. The former standalone
Express app and prefix-based strangler dispatcher are gone; Express remains only
as Nest's HTTP adapter and for a small set of platform routes registered before
`app.init()`.

Historical references to a "legacy" route or service describe the compatibility
contract that a Nest controller preserves. They do not indicate an active Express
fallback.

## Application composition

`server/src/index.ts` owns the process lifecycle: filesystem preparation, HTTP
listen, schedulers, WebSocket startup and graceful shutdown. It calls
`server/src/bootstrap.ts`, whose registration order is load-bearing:

1. global security/auth middleware;
2. guarded uploads and fixed Android release routes;
3. health, OAuth/MCP transport and well-known metadata;
4. production static assets and optional API docs;
5. `app.init()` for every Nest domain controller.

`app.module.ts` is the module inventory and registers the global exception/SPA
filters plus mutation idempotency interceptor.

## Module layout (per domain)

```text
shared/src/<domain>/<domain>.schema.ts(.spec.ts)    # Zod contract
server/src/nest/<domain>/<domain>.service.ts        # domain/core-service adapter
server/src/nest/<domain>/<domain>.controller.ts     # route/auth/status contract
server/src/nest/<domain>/<domain>.module.ts         # AppModule registration
```

Controllers own HTTP parsing, guards, status codes and error envelopes. Domain
services stay thin and delegate SQL/provider/business side effects to
`server/src/services/` unless the module itself is the canonical owner.

## Current registered surface

- **Foundation/public:** database, health, weather, help, airports, config,
  system-notices, maps, categories, tags and notifications.
- **Trip domains:** trips, days, assignments, places, reservations/accommodations,
  packing, todo, budget, collab, files, share, trip invites, transit, feeds and
  booking import.
- **Personal/addon/media:** atlas, vacay, photos, memories, AirTrail, journey and
  collections.
- **Identity/admin/extensions:** settings, backup, auth, OIDC, OAuth, admin,
  addons and plugins.
- **Platform routes outside domain controllers:** uploads/static assets,
  `/api/health`, OAuth/MCP SDK transport and metadata, API docs, Digital Asset
  Links/APK and the SPA fallback.

The executable inventory is `app.module.ts` and `bootstrap.ts`; update this list
when either changes.

## Cross-cutting foundation

- `common/idempotency.interceptor.ts` replays the client's
  `X-Idempotency-Key` on authenticated mutations so offline retries cannot
  double-apply writes.
- `common/trek-exception.filter.ts` preserves TREK's established error envelope.
- `platform/spa-fallback.filter.ts` serves `index.html` for unmatched production
  GET routes without swallowing `/api` errors.
- `middleware/globalMiddleware.ts` applies Helmet/CSP, CORS, HSTS, forced HTTPS,
  MFA policy, request logging and cookies to the single Nest application.
- `server/src/websocket.ts` remains the live-sync transport; controllers/services
  must preserve sender exclusion and viewer-scoped privacy.

## Compatibility rules

- Preserve the existing URL, method, query/body coercion, status, cookies and JSON
  error body when moving or refactoring a route.
- A POST that historically returned 200 still needs `@HttpCode(200)`; Nest defaults
  a create to 201.
- Declare static sub-routes before a colliding `:id` route.
- Trip-scoped handlers verify trip access and the relevant permission, then forward
  `X-Socket-Id` to scoped broadcasts.
- Reuse `@trek/shared` schemas where available; a schema must not silently widen an
  auth or data-ownership boundary.

## Test map

1. **Controller/service unit tests** — `server/tests/unit/nest/`. Assert exact
   status/error contracts, guard inputs and side-effect delegation.
2. **Nest e2e tests** — `server/tests/e2e/`. Boot the real AppModule against an
   isolated SQLite database and exercise real guards and route ordering.
3. **Integration tests** — `server/tests/integration/`. Cover cross-domain service,
   provider, plugin, MCP and bootstrap behavior.
4. **WebSocket tests** — `server/tests/websocket/` plus domain-specific privacy
   tests. Assert allowed viewers, revoked viewers and sender behavior.

The coverage gate in `server/vitest.config.ts` scopes the Nest surface and must not
be weakened to make a module pass.

## Definition of done (per domain change)

Contract in `@trek/shared` when applicable → service/controller/module wiring →
unit + e2e/integration evidence → auth/privacy and WebSocket negative cases →
client API/repository consumer → typecheck and coverage. Platform/bootstrap changes
also need static, health, OAuth/MCP and SPA fallback integration checks.
