# Place Enrichment Cost Guard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add preview-first place refresh and a durable monthly hard cap for all TREK Google Places calls, then deploy it safely.

**Architecture:** A small SQLite-backed usage ledger reserves a SKU attempt before every outbound Google request. Place enrichment adds trip-scoped Nest endpoints over the existing place/maps services and a modal in the existing Places sidebar. Existing place fields remain authoritative and only empty provider/contact columns are filled.

**Tech Stack:** TypeScript, NestJS, better-sqlite3, React, Zustand, Zod, Vitest, Testing Library, Docker Compose.

---

### Task 1: Add the durable Google usage ledger

**Files:**
- Modify: `server/src/db/migrations.ts`
- Create: `server/src/services/googleApiUsageService.ts`
- Create: `server/tests/unit/services/googleApiUsageService.test.ts`
- Modify: `server/tests/unit/db/migration-hygiene.test.ts` only if required by the migration contract

1. Write failing tests for Pacific billing-period selection, atomic pre-call reservation, exact-cap rejection, conservative failed-attempt counting, downward-only environment overrides, zero cap, and snapshots.
2. Run the focused test and confirm RED.
3. Add the additive `google_api_usage` migration and the smallest ledger implementation.
4. Run the focused test, migration hygiene, and migration rerun checks; confirm GREEN.

### Task 2: Put every Google Places call behind the ledger

**Files:**
- Modify: `server/src/services/mapsService.ts`
- Modify: `server/src/services/authService.ts`
- Modify: `server/tests/unit/services/mapsService.test.ts`
- Modify: `server/tests/unit/services/authServiceDb.test.ts`

1. Add failing tests asserting the correct SKU is reserved before search, autocomplete, lean details, expanded details, photo, and key validation calls; assert cache hits do not reserve.
2. Run focused tests and confirm RED.
3. Change the Google fetch helper to require a SKU and reserve before `fetch`; route the direct key-validation request through the ledger and reduce it to an IDs-only field mask.
4. Keep generic search on Enterprise, add a Pro-only candidate search for enrichment, and count photo fetches conservatively before the photo lookup.
5. Run focused tests and confirm GREEN.

### Task 3: Add preview and selected-apply enrichment services

**Files:**
- Modify: `shared/src/place/place.schema.ts`
- Modify: `server/src/services/placeEnrichment.ts`
- Modify: `server/src/nest/places/places.service.ts`
- Modify: `server/src/nest/places/places.controller.ts`
- Modify: `server/tests/unit/services/placeEnrichment.test.ts`
- Modify: `server/tests/unit/nest/places.controller.test.ts`
- Modify: `server/tests/integration/places.test.ts`

1. Add failing tests for candidate distance/confidence, unlinked-place selection, 100-item limits, invalid Google IDs, 404-before-403 ordering, `place_edit`, partial quota results, 250m apply validation, trip scoping, fill-empty-only behavior, and websocket broadcasts.
2. Run the focused unit/integration tests and confirm RED.
3. Add Zod request contracts and typed response contracts.
4. Implement Pro-mask preview with concurrency three and selected apply through fresh Place Details.
5. Preserve all user-owned fields and skip automatic photos/categories/scheduling.
6. Run the focused tests and confirm GREEN.

### Task 4: Add the Places refresh modal

**Files:**
- Create: `client/src/components/Planner/PlaceEnrichmentModal.tsx`
- Modify: `client/src/components/Planner/PlacesSidebar.tsx`
- Modify: `client/src/components/Planner/PlacesSidebarHeader.tsx`
- Modify: `client/src/components/Planner/usePlacesSidebar.ts`
- Modify: `client/src/components/Planner/PlacesSidebar.test.tsx`
- Modify: `client/src/api/client.ts`
- Modify: `shared/src/i18n/en/places.ts`
- Modify: `shared/src/i18n/ko/places.ts`
- Modify: `shared/src/i18n/ja/places.ts`

1. Add failing component tests for action visibility, scan loading, cost/usage copy, safe defaults, manual selection, partial error, hard-cap state, apply, reload, and close/focus behavior.
2. Run the focused client test and confirm RED.
3. Add typed API methods and the modal using existing TREK design tokens/components.
4. Add English, Korean, and Japanese strings; other locale bundles carry explicit English fallback values to preserve key parity.
5. Run focused client tests and confirm GREEN.

### Task 5: Verification and production rollout

**Files:**
- Modify: relevant operator documentation and generated TREK wiki pages
- Modify: deployment override only after backup and image build verification

1. Run shared build, focused tests, all workspace type/build checks, and the full server/client suites.
2. Run migration twice against a disposable database and verify the usage table and version.
3. Start an isolated local stack and capture authenticated 390px and 1440px screenshots covering initial and preview-result states.
4. Review auth, quota races, data preservation, provider error handling, billing assumptions, rollback, and logs for secret exposure.
5. Create a fresh production SQLite backup and checksum; record the previous image tag and rollback command.
6. Build/tag the custom image, update the Compose override, deploy, and wait for healthy status.
7. Smoke-test public HTTPS health/config, authenticated permissions, usage status, and a guarded preview without exposing credentials.
8. Update the generated TREK runbook/wiki with the cost-guard behavior, evidence, and remaining external Google Console steps; validate the wiki.
