# Map Labels and Google Usage Administration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add selectable Korean/local map labels and a protected administrator view/control for TREK-local Google Places usage, then deploy and verify it safely.

**Architecture:** A pure MapLibre layer-localization helper preserves provider expressions while user settings choose the desired locale. Existing admin guards expose the current Google usage ledger and an app-setting-backed enrichment switch; both enrichment endpoints enforce that switch server-side.

**Tech Stack:** TypeScript, React, Zustand, MapLibre/Mapbox GL, NestJS, SQLite app settings, Vitest, Testing Library, Docker Compose.

---

### Task 1: Add the MapLibre localization contract

**Files:**
- Modify: `client/src/components/Map/glProviders.ts`
- Modify: `client/src/components/Map/glProviders.test.ts`
- Modify: `client/src/types.ts`
- Modify: `client/src/store/settingsStore.ts`

1. Write failing tests for locale resolution, Korean and English name fallbacks, native restoration, non-name layer preservation, and repeated language switches without nested expressions.
2. Run the focused test and confirm RED.
3. Add the label-language type/default and the smallest pure/runtime localization helpers.
4. Run the focused test and confirm GREEN.

### Task 2: Wire both GL maps and the settings UI

**Files:**
- Modify: `client/src/components/Map/MapViewGL.tsx`
- Modify: `client/src/components/Map/JourneyMapGL.tsx`
- Modify: `client/src/components/Settings/MapSettingsTab.tsx`
- Modify: `client/src/components/Map/MapViewGL.test.tsx`
- Modify: relevant map/settings component tests
- Modify: `shared/src/i18n/en/settings.ts`
- Modify: `shared/src/i18n/ko/settings.ts`

1. Add failing component tests for the default, save behavior, Leaflet limitation copy, MapLibre application, Mapbox config, and native restoration.
2. Run focused tests and confirm RED.
3. Wire `auto`, `local`, `ko`, and `en` through settings and both maps, handling style readiness/reloads.
4. Add English and Korean strings with the project's existing fallback behavior for other locales.
5. Run focused tests and confirm GREEN.

### Task 3: Expose protected local usage and enrichment control APIs

**Files:**
- Modify: `server/src/nest/admin/admin.controller.ts`
- Modify: `server/src/nest/admin/admin.service.ts`
- Modify: `server/src/services/adminService.ts`
- Modify: `server/src/services/authService.ts`
- Modify: `server/src/nest/places/places.controller.ts`
- Modify: `server/src/nest/places/places.service.ts`
- Modify: `server/tests/unit/nest/admin.controller.test.ts`
- Modify: `server/tests/unit/nest/places.controller.test.ts`
- Modify: relevant auth/config integration tests

1. Add failing tests for the usage response, boolean validation, default-enabled setting, persistence, public flag, and 403 enforcement on preview/apply.
2. Run focused tests and confirm RED.
3. Add the guarded admin endpoints, service methods, public boolean flag, and server-side enrichment checks using existing patterns.
4. Add or extend an integration negative-auth check so non-admin callers cannot read usage or change the switch.
5. Run focused unit/integration tests and confirm GREEN.

### Task 4: Add the admin usage panel and switch wiring

**Files:**
- Create: `client/src/components/Admin/GoogleApiUsagePanel.tsx`
- Create: `client/src/components/Admin/GoogleApiUsagePanel.test.tsx`
- Modify: `client/src/pages/admin/AdminSettingsTab.tsx`
- Modify: `client/src/pages/admin/useAdmin.ts`
- Modify: `client/src/api/client.ts`
- Modify: `client/src/store/authStore.ts`
- Modify: `client/src/App.tsx`
- Modify: `client/src/components/Planner/usePlacesSidebar.ts`
- Modify: `shared/src/i18n/en/admin.ts`
- Modify: `shared/src/i18n/ko/admin.ts`

1. Add failing tests for loading, loaded metrics, exhausted state, retry, refresh, toggle persistence, public-config wiring, and hidden enrichment action.
2. Run focused tests and confirm RED.
3. Implement a responsive local-usage panel and wire the dedicated switch through the existing admin/settings stores and client API.
4. Add accessible English and Korean copy that states the ledger's TREK-local scope and external billing limitation.
5. Run focused tests and confirm GREEN.

### Task 5: Verify, review, deploy, and document

**Files:**
- Modify: generated TREK deployment/operations wiki documentation
- Modify: deployment Compose override only after backup and image verification

1. Run focused tests, shared build, client/server type/build checks, and the full relevant test suites.
2. Perform an adversarial review of admin authorization, app-setting defaults, stale-client bypass, map style mutation, cost claims, logs, rollback, and regression risk; address material findings.
3. Start an isolated app where practical and capture 390px and 1440px screenshots for map settings and the admin usage state.
4. Read the OCI storage policy, verify block-volume paths/capacity, create a fresh production database backup and checksum, and record the previous image/rollback command.
5. Build and tag the new image, update the Compose override, deploy, and wait for a healthy container.
6. Verify public HTTPS health/config, TLS, admin endpoint authorization, the target user's normal login path without impersonation, and that the local ledger remains unchanged unless an intentional provider call is made.
7. Update and validate generated TREK operational knowledge without recording credentials or raw sensitive logs.
