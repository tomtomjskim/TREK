# Public Shared Place Notes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

> 실행 결과: local integrated tree에서 완료. Exact DTO/API `0842e229`, client/i18n/E2E
> `c3b8e18f`; server 74/74, affected client 170/170, shared i18n 4/4, public Playwright
> 4/4, 23-locale semantic review와 independent final review PASS. 전체 v4.1.1 release는
> restore quiesce/crash-recovery 및 release rehearsal 미완료로 별도 NO-GO.

**Goal:** Show trip-shared `places.notes` in public map details and plan rows while keeping every other note field separate and preserving anonymous-share privacy boundaries.

**Architecture:** Replace every wildcard row projection in the v4 Nest anonymous payload with a typed,
section-specific allowlist, add the missing nested place-note field, then render one normalized
place-note view in the shared React page using the integrated v4 Markdown/link components. Correct
the misleading personal-note copy and prove positive sharing, disabled-flag no-query,
cross-flag/internal-field non-disclosure and revocation.

**Tech Stack:** NestJS/SQLite, React 19, React-Leaflet 5/Leaflet 1.9, react-markdown, Vitest, Testing Library, Playwright, shared i18n.

---

> 실행 전제: v4.1.1 integration branch의 DB/auth/privacy/fork preservation gate가 안정화됨
> preservation ID: `SHARE-01`
> migration/new dependency: 없음

All server/client paths and `typecheck:tests` below are post-merge target contracts verified with
`git show v4.1.1^{}:<path>`. They may be absent in the pre-merge 3.4.1 fork; after integration they
must exist. Do not redirect this task to legacy `server/src/services/shareService.ts`.

## Task 1: Add the server projection RED tests

**Files:**

- Modify `server/tests/unit/nest/share.service.test.ts`
- Modify `server/tests/integration/share.test.ts`

**Step 1: Add distinct sentinels in the unit test**

Create `SHARE-SVC-032` with:

- `places.notes = 'PLACE_SHARED_SENTINEL'`
- `day_assignments.notes = 'ASSIGNMENT_SENTINEL'`
- assertions for top-level `places[].notes` and nested `assignment.place.notes`
- a whole-response assertion that the internal assignment sentinel and assignment `notes` key are absent

Also extend the existing no-map unit test so `JSON.stringify(data)` does not contain a seeded
`DO_NOT_SHARE_PLACE_NOTE`.

Add `SHARE-SVC-033` with exact-key assertions for root/trip/permissions, days, assignments, nested
Place/Category, day notes and top-level Place/Category shapes, including explicit omission of unused
compact Tags and a spy proving the compact Tag loader is not called. Add `SHARE-SVC-033b` for exact
reservation/accommodation/packing/budget/collab keys. Seed distinct parent IDs, `user_id`, provider
IDs, sync/internal state, database audit timestamps and cross-flag sentinels in every section. Prove
none serialize except user-visible schedule/message times explicitly listed in the approved key table.
Use query spies to prove each disabled share flag issues no section query and returns its documented
empty shape; in particular `share_map=false` returns no categories. Prove `carto_api_key` is never
read or transmitted and `cartoApiKey` is always `''`, including when map is enabled. Prove owner
settings are fetched only when budget is enabled and only `default_currency` affects the response.
Add `SHARE-SVC-034` for the old-token payload/photo revocation and different-token reissue lifecycle.

**Step 2: Run the focused unit test and confirm RED**

```bash
npm --workspace server test -- --run tests/unit/nest/share.service.test.ts
```

Expected RED reasons on the pinned target are recorded independently: the nested
`assignment.place.notes` assertion fails; `p.*`, `da.*`, `r.*`, other `SELECT *` rows and compact Tag
objects violate their section key assertions; global categories violate the map-off/category scope;
assignment notes and unused place/category fields serialize; and the unused owner CARTO credential is
read/transmitted. Token/auth lifecycle assertions must remain GREEN. If any assertion fails for a
reason outside this list, diagnose before implementation.

**Step 3: Add HTTP integration assertions**

Add `SHARE-030` for a valid anonymous token, `SHARE-031` for exact keys in every response section,
whole-response forbidden sentinels, cross-flag absence and disabled-flag query spies, and `SHARE-032`
for payload/photo revocation and different-token reissue. Extend `SHARE-024` no-map coverage with a
place-note/internal-field/category sentinel. Keep invalid/expired token tests intact.

**Step 4: Run integration RED**

```bash
npm --workspace server test -- --run tests/integration/share.test.ts
```

Expected: nested public projection and wildcard-allowlist assertions fail for their stated reasons;
no-map note assertion remains GREEN. Diagnose any auth/token lifecycle failure before implementation.

## Task 2: Build the typed anonymous projection and add the note

**Files:**

- Modify `server/src/nest/share/share.service.ts`
- Create `server/src/nest/share/public-share.types.ts`

**Step 1: Freeze and approve the exact public key table**

Re-run the pinned `SharedTripPage`/direct-helper consumer trace and compare it to the exact table in
the design/evidence documents. Record the independent security verdict for every row before source
edits. A discrepancy, `PENDING`, `TBD`, “all safe fields” or an unreviewed object spread blocks this
task; update the design deliberately rather than widening the implementation ad hoc.

**Step 2: Implement explicit projections**

Replace every `SELECT *`, `alias.*` and unreviewed row/object spread inside `getSharedTripData`,
including the token lookup, days, assignments, day notes, places/tags/categories, reservations,
accommodations, packing, budget and collab, with explicit column lists and typed object constructors.
Select only categories referenced by the trip's public places and return no categories when
`share_map=false`. Never read or transmit the owner CARTO credential; keep the compatibility field as
`cartoApiKey: ''`. Fetch owner settings only when budget is enabled and derive only the display
currency. Every returned section must match the reviewer-approved table; do not expose assignment
notes, unused place/category fields, parent/user/provider/sync/audit fields, booking data through
Place, payer IDs or private packing linkage.

Remove the unused compact Tag load and the `QueryHelpersService` constructor dependency from this
service rather than querying data that the exact DTO excludes. Do not edit the query-helper module.

Inside the nested assignment `place` projection, also add:

```ts
notes: a.place_notes,
```

Return `PublicSharedTripData | null` rather than `Record<string, any> | null`. Do not return
`assignment.notes` or add it to the place, broaden any share flag or expose additional columns.

**Step 3: Run server GREEN**

```bash
npm --workspace server test -- --run \
  tests/unit/nest/share.service.test.ts \
  tests/integration/share.test.ts
npm --workspace server run typecheck
npm --workspace server run typecheck:tests
```

Expected: both place-note projections match; every root and nested section has exactly the approved
keys; assignment/internal/provider/sync/audit and cross-flag sentinels are absent; the CARTO setting
was never read; disabled sections were not queried; revocation fails closed; and no-map shapes are
empty.

**Step 4: Review the diff**

```bash
git diff -- server/src/nest/share/share.service.ts \
  server/src/nest/share/public-share.types.ts \
  server/tests/unit/nest/share.service.test.ts \
  server/tests/integration/share.test.ts
git diff --check
```

## Task 3: Add client RED tests for map and plan semantics

**Files:**

- Modify `client/src/pages/SharedTripPage.test.tsx`

**Step 1: Extend the react-leaflet mock**

Add a minimal `Popup` mock that renders children in a scoped test element. Preserve existing Marker,
Tooltip and map event behavior.

**Step 2: Add `FE-PAGE-SHARED-042`**

Use the same place note in top-level and nested projections. Give the nested plan place an address
and description; keep the top-level map place at its approved minimal shape. Assert:

- address remains visible;
- plan note is separately visible;
- trip-wide marker detail contains the note.

**Step 3: Add `FE-PAGE-SHARED-043`**

Use different top-level and nested sentinels. Select the day and assert the map detail uses the nested
sentinel. This prevents the client from hiding a server projection regression by joining against the
top-level pool.

**Step 4: Add `FE-PAGE-SHARED-044`**

Use distinct place, assignment, day-note and collab-message sentinels. Scope assertions to the place
Popup/row and prove only the place sentinel renders there.

**Step 5: Add `FE-PAGE-SHARED-045`**

Cover null/empty/whitespace, multiline, long no-space text, Markdown link and raw `<script>`.

**Step 6: Add `FE-PAGE-SHARED-046`**

Capture Marker props in the mock and prove trip-wide and selected-day markers receive the place name
as `title`. Keep actual role/name/focus/open/close behavior for Playwright.

**Step 7: Add `FE-PAGE-SHARED-047`**

With mocked Leaflet markers, prove keyboard activation records only the current marker element,
close-button/Escape keyboard intent restores that current opener after `popupclose`, pointer/touch
close does not force focus, and opening another marker clears the old restore target. Real DOM/Leaflet
behavior remains mandatory in Playwright.

**Step 8: Run and confirm RED**

```bash
npm --workspace client test -- --run src/pages/SharedTripPage.test.tsx
```

Expected: new place-note rendering assertions fail; existing share tests remain GREEN.

## Task 4: Render safe, persistent place details

**Files:**

- Modify `client/src/pages/SharedTripPage.tsx`
- Modify `client/src/pages/SharedTripPage.test.tsx`
- Modify target-provided `client/src/components/shared/markdownLink.test.tsx`

**Step 1: Reuse existing Markdown primitives**

Import the target v4.1.1 React Markdown alias/pattern, `remark-gfm`, `remark-breaks`,
`markdownLinkComponents`, and React-Leaflet `Popup`. The v4 integration baseline provides the helper;
verify it in the merged tree before this task. Its absence there is an integration blocker, not a
reason to create a replacement. Do not add dependencies or raw-HTML plugins.

**Step 2: Normalize display-only emptiness**

Treat non-string and trimmed-empty notes as absent. Preserve the original non-empty text for Markdown
line breaks after the emptiness check.

**Step 3: Add Marker detail and explicit focus restoration**

Keep the current name Tooltip. Give every Marker `title={p.name}` and preserve/add a visible
focus-visible style for the custom icon. Add a Popup with name and optional note. Apply bounded
height, scrolling and `overflowWrap:anywhere` without changing the map viewport or route polyline.

Keep Leaflet Marker instances/elements in a place-keyed ref map. On Marker keyboard `keypress`
(Enter/Space), record that marker as the current keyboard opener. Use Marker `popupopen`/
`popupclose` handlers plus a close-intent handler scoped to the map/Popup: Escape or keyboard
activation of the Popup close button marks restore intent, and `popupclose` restores focus to the
still-current opener after the Popup DOM is removed. Pointer/touch close must clear without forcing
focus. Opening another marker clears the old opener/intent. Remove listeners on close/unmount and do
not query or focus a marker outside this map instance.

**Step 4: Add the plan note block**

After the existing address/description line, render a distinct Markdown note block. Do not replace the
fallback line or read `item.data.notes`.

**Step 5: Extend the target safe-link regression**

In `markdownLink.test.tsx`, retain HTTP(S), relative/hash and current safe-protocol behavior; assert
`javascript:`, `data:` and `file:` produce no navigable target, raw HTML does not execute, and valid
links retain `target="_blank"` plus `noopener noreferrer nofollow`.

**Step 6: Run focused GREEN**

```bash
npm --workspace client test -- --run \
  src/pages/SharedTripPage.test.tsx \
  src/components/shared/markdownLink.test.tsx
npm --workspace client run typecheck
npm --workspace client run theme:lint:strict
```

Expected: all new states and existing map/day-order tests pass, raw script is inert, unsafe schemes
are stripped, and safe links remain GREEN.

## Task 5: Correct the shared-note copy and disclosure

**Files:**

- Modify `shared/src/i18n/*/places.ts`
- Modify `shared/src/i18n/*/share.ts`
- Create `shared/src/i18n/i18n-place-notes.spec.ts`
- Modify `client/src/components/Trips/TripMembersModal.test.tsx`

**Forbidden:** every other shared test/helper. If the new semantic test needs a reusable helper,
obtain root-integrator approval and add its exact path to ownership before editing.

**Step 1: Inventory all locales before editing**

```bash
rg -n "'places\.formNotesPlaceholder'|'share\.linkHint'" shared/src/i18n/*/{places,share}.ts
```

Expected: all 23 locales are represented.

**Step 2: Change semantics, not keys**

- `places.formNotesPlaceholder`: describe place/trip-shared notes, never personal/private notes.
- `share.linkHint`: disclose that Map & Plan includes place and itinerary notes visible to anyone with
  the link.

Do not machine-copy English across every locale. Preserve locale punctuation/style and request a
read-only locale semantic review if any translation is uncertain.

**Step 3: Add semantic guardrails**

Assert exact intended English and Korean values and that all locale modules retain both keys. Fill the
evidence ledger's 23-locale proposed-text/reviewer/verdict rows; `PENDING` is not a passing review.
Add a client assertion that the updated `share.linkHint` is actually rendered in
`TripMembersModal.tsx` because parity alone cannot prove user disclosure.

**Step 4: Run shared gates**

```bash
npm --workspace shared run i18n:parity:strict
npm --workspace shared run typecheck
npm --workspace shared test
npm --workspace shared run format:check
```

**Step 5: Re-run the client page test**

```bash
npm --workspace shared run build
npm --workspace client test -- --run \
  src/pages/SharedTripPage.test.tsx \
  src/components/Trips/TripMembersModal.test.tsx
```

## Task 6: Add anonymous browser and responsive evidence

**Files:**

- Create `client/e2e/shared-trip-place-notes.public.spec.ts`

**Forbidden:** `client/e2e/helpers.ts`, `client/e2e/server-launch.mjs`, Playwright config and all
other specs. If the isolated spec cannot seed through test-only HTTP APIs, stop and coordinate a new
explicit helper path rather than editing a shared fixture implicitly.

**Step 1: Seed test-only public data**

Create a test trip with separate place, assignment, day and collab sentinels. Use a separate test-only
`APIRequestContext` for authenticated setup, dispose it, then navigate with the public project's
cookie-free page. Generate the token through the test API, never a production link, and assert the
page context has no auth cookie before reading the share.

**Step 2: Desktop cases at 1440×900**

- open without auth cookies;
- open trip-wide marker Popup;
- choose a day and open the selected-day Popup;
- expand plan row and verify address + note;
- save screenshots bound to the test run.

**Step 3: Mobile cases at 390×844**

- tap marker, verify Popup and close behavior;
- verify long Korean/English/no-space wrapping;
- verify no page-level horizontal overflow;
- verify safe link can be focused/tapped.

**Step 4: Keyboard and security cases**

- focus the marker by its place-name accessible name, observe visible focus, open with Enter, then
  keyboard-activate the Popup close button and verify focus returns to that marker;
- reopen with Enter, close with Escape and verify focus returns; then pointer/touch-close and verify
  no programmatic focus jump to the old marker;
- open a second marker and prove closing it never restores focus to the first marker;
- inspect exact response projection keys and cross-flag sentinels in the same no-cookie page;
- create/obtain a `share_map=false` fixture and prove sentinel absence;
- verify invalid/expired token and photo proxy fail closed;
- revoke a working token, prove its payload/photo fail closed, then prove a reissued token differs;
- assert console/page errors and React warnings are zero.

**Step 5: Run the dedicated E2E**

```bash
npm --workspace client run e2e -- --project=public shared-trip-place-notes.public.spec.ts
```

If actual Leaflet marker keyboard behavior differs from the design, do not weaken the test silently.
Record the evidence and add the smallest accessible interaction fix.

## Task 7: Run regression gates and update evidence

**Files:**

- Update `docs/plans/2026-09-01-public-share-place-notes-evidence.md`
- Update `docs/upstream/README.md` patch inventory/evidence link
- Update `docs/README.md` status link without changing current runtime version

**Step 1: Focused final gate**

```bash
npm --workspace shared run i18n:parity:strict
npm --workspace server test -- --run \
  tests/unit/nest/share.service.test.ts \
  tests/integration/share.test.ts
npm --workspace client test -- --run \
  src/pages/SharedTripPage.test.tsx \
  src/components/shared/markdownLink.test.tsx
npm --workspace client test -- --run src/components/Trips/TripMembersModal.test.tsx
npm --workspace client run e2e -- --project=public shared-trip-place-notes.public.spec.ts
```

**Step 2: Broader gate**

```bash
npm --workspace server run typecheck
npm --workspace server run typecheck:tests
npm --workspace client run typecheck
npm --workspace client run lint:check
npm --workspace client run theme:lint:strict
npm run build
npm test
git diff --check
```

**Step 3: Independent reviews**

Run a specification review against every acceptance criterion, then code-quality/security review.
Resolve findings and rerun affected tests before closeout.

**Step 4: Evidence binding**

Record:

- exact RED failure and GREEN commands/pass counts;
- final SHA/tree state;
- API positive and negative sentinel assertions;
- desktop/mobile/keyboard screenshots and console/network evidence;
- locale semantic review;
- warnings and omitted tests with reasons.

Do not mark `SHARE-01` `VERIFIED` until every item is fresh against the final tree.
