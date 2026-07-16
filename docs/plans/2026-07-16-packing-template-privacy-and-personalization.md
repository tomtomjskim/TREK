# Packing Template Privacy and Personalization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent private trip packing items from entering instance-wide templates, then evolve templates into separate personal and instance-wide scopes without breaking existing shared templates.

**Architecture:** The immediate hotfix keeps the existing API and schema intact and limits instance-template snapshots to Common (`is_private = 0`) trip items. The later personalization phase adds an explicit template visibility field, treats `created_by` as ownership for private templates, and keeps all existing templates as instance-wide data.

**Tech Stack:** TypeScript, NestJS, better-sqlite3, SQLite migrations, Vitest, Supertest, React 19.

---

## Architecture readiness

- **Readiness:** `full_gate_required` because the behavior crosses an authenticated API, authorization rules, and a privacy boundary.
- **Surfaces:** packing service query, save/apply API contract, SQLite template ownership, admin and user template UI, tests, deployment image.
- **Immediate rollback:** `code_only`; reverting the query restores the prior behavior. No schema or production data is changed by the hotfix.
- **Later rollback:** `data_migration`; back up the SQLite database, use an additive migration, and retain the old admin endpoints until the new routes have passed authorization tests.
- **Evidence:** unit red/green test, API integration negative test, packing service/controller suites, server typecheck/build, diff check, and deployment health/log checks only when deployment is separately authorized.

## Permission contract

| Template scope | List/apply                                        | Create/update/delete | Snapshot source                                                                 | Applied item visibility   |
| -------------- | ------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------- | ------------------------- |
| `instance`     | Authenticated user with access to the target trip | Admin                | Common items only                                                               | Common                    |
| `private`      | Owning user                                       | Owning user          | Common items plus private items owned by the caller; never recipient-only items | Personal, owned by caller |

The current `POST /api/trips/:tripId/packing/save-as-template` endpoint remains an admin-only instance-template operation for backward compatibility. A later personal-template endpoint must be user-owned instead of weakening the existing admin route.

### Task 1: Lock the privacy regression with tests

**Files:**

- Modify: `server/tests/unit/services/packingService.test.ts`
- Modify: `server/tests/integration/packing.test.ts`

**Step 1: Write the failing service tests**

Add cases that create Common, Personal, and Shared items, save the trip as an instance template, and assert that only the Common item is copied. Add a private-only case that expects `null` and verifies no empty template row is created.

**Step 2: Write the failing API test**

Have a trip member create a Personal item, have the trip admin save an instance template, then query the template rows directly and assert that the member's Personal item is absent.

**Step 3: Verify RED**

Run:

```bash
npm exec --workspace=server -- vitest run tests/unit/services/packingService.test.ts tests/integration/packing.test.ts
```

Expected before the fix: the new assertions fail because `saveAsTemplate()` selects every row for the trip.

### Task 2: Apply the minimum privacy fix

**Files:**

- Modify: `server/src/services/packingService.ts:420`

**Step 1: Restrict the snapshot query**

Change the source query to:

```sql
SELECT name, category
FROM packing_items
WHERE trip_id = ? AND is_private = 0
ORDER BY sort_order ASC
```

No API response, controller guard, database table, or frontend behavior changes in this hotfix.

**Step 2: Verify GREEN**

Run the targeted unit and integration suites again and confirm the new tests and existing template tests pass.

### Task 3: Verify the hotfix boundary

**Files:**

- Verify only: `server/src/services/packingService.ts`
- Verify only: `server/src/nest/packing/packing.controller.ts`

**Step 1: Run the broader packing tests**

```bash
npm exec --workspace=server -- vitest run tests/integration/packing.test.ts tests/unit/services/packingService.test.ts tests/unit/nest/packing.controller.test.ts
```

**Step 2: Run static checks**

```bash
npm run typecheck --workspace=server
git diff --check
```

**Step 3: Review the diff**

Confirm there is no migration, dependency, generated artifact, credential, or unrelated formatting change.

### Task 4: Implement personal templates in a later gated change

**Files:**

- Modify: `server/src/db/migrations.ts`
- Modify: `server/src/services/packingService.ts`
- Modify: `server/src/services/adminService.ts`
- Modify: `server/src/nest/packing/packing.controller.ts`
- Modify: `server/src/nest/admin/admin.controller.ts`
- Modify: `client/src/components/Packing/ApplyTemplateButton.tsx`
- Modify: `client/src/components/Packing/PackingListPanelHeader.tsx`
- Modify: `client/src/pages/AdminPage.tsx`
- Test: `server/tests/integration/packing.test.ts`
- Test: `server/tests/unit/services/packingService.test.ts`
- Test: relevant client component tests

**Step 1: Add an additive scope migration**

Add `visibility TEXT NOT NULL DEFAULT 'instance'` to `packing_templates`, validate allowed values (`instance`, `private`) in service code, and index `(visibility, created_by, created_at)`. The default backfills every existing row as `instance` without rewriting template contents.

**Step 2: Add owner-scoped user routes**

- Keep existing admin CRUD restricted to `visibility = 'instance'`.
- Add `GET /api/packing-templates` for the authenticated user's accessible `private` and `instance` catalog.
- Add `POST /api/trips/:tripId/packing/templates` with `{ name }` to create a private template from that trip after trip-access and `packing_edit` checks.
- Add `PATCH /api/packing-templates/:id` and `DELETE /api/packing-templates/:id` for owner-only private-template management.
- Keep `GET /api/trips/:tripId/packing/templates` as a backward-compatible wrapper for the apply flow.
- Always derive `created_by` from the JWT user; never accept an owner id from the request body.
- List only `visibility = 'instance' OR (visibility = 'private' AND created_by = :userId)`.
- Reject reading, applying, updating, or deleting another user's private template.

**Step 3: Preserve item privacy when saving and applying**

- Instance snapshot: include only `is_private = 0`.
- Private snapshot: include Common items and private items whose `owner_id` is the caller; exclude private items merely shared with the caller.
- Apply an instance template as Common items.
- Apply a private template as Personal items with `owner_id = caller`.

**Step 4: Update the UI information architecture**

- Add `내 템플릿` and `공용 템플릿` tabs to the apply flow.
- Put personal CRUD under user settings.
- Rename the admin entry to `공용 짐 템플릿`.
- Keep the current admin save action explicitly labelled as a shared/instance operation.
- Show explicit empty states for no personal templates, no shared templates, and no Common items eligible for an instance snapshot.
- Default a normal user's save action to `내 템플릿`; never silently promote it to the instance catalog.

**Step 5: Gate the migration and rollout**

- Back up the production SQLite database.
- Run migration tests from a copy of the current database.
- Verify cross-user negative tests, old-template backfill, and API compatibility.
- Build an immutable image and deploy only after explicit production authorization.
- Roll back to the prior image and restored DB backup if the migration or authorization checks fail.

## Required future tests

1. User A cannot list, apply, update, or delete User B's private template.
2. Admin cannot inspect or mutate private templates through admin endpoints.
3. Existing templates migrate to `instance` and remain listable/applicable.
4. Instance snapshots never contain Personal or Shared-with-people items.
5. Private snapshots never contain another owner's private item, including recipient-shared items.
6. Instance application creates Common items; private application creates caller-owned Personal items.
7. Deleting a user follows an explicitly accepted private-template lifecycle policy.
