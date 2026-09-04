# Public Shared Place Notes Evidence

> 작성일: 2026-09-01
> 상태: implemented + locally verified
> target baseline: `SHARE-01` local integrated v4.1.1 fork tree; API `0842e229`, client/i18n/E2E `c3b8e18f`
> fresh verification: place-note application source `200df8b4`, public client/browser hardening `69f83999` + `3ee91284` + `a55fcccb`, integrated code/test checkpoint `a55fcccb`; 2026-09-04
> preservation ID: `SHARE-01`

## Pre-fix root-cause snapshot

The table below describes the pinned v4.1.1 source before `0842e229`/`c3b8e18f`; the current
candidate implements the missing projection and rendering described here.

| Surface            | v4.1.1 evidence                                         | Finding                                                           |
| ------------------ | ------------------------------------------------------- | ----------------------------------------------------------------- |
| server query       | `server/src/nest/share/share.service.ts` around 178–190 | reads `p.notes AS place_notes`                                    |
| nested projection  | same file around 195–208                                | drops `notes` from `assignment.place`                             |
| trip-wide pool     | same file around 221–225                                | `SELECT p.*` already includes `places.notes`                      |
| selected-day input | `client/src/pages/SharedTripPage.tsx` around 159–179    | uses nested assignment places                                     |
| map output         | same file around 518–522                                | renders only name Tooltip                                         |
| plan output        | same file around 796–850                                | renders name and `address`, `description`, but not the place note |

The same two omissions exist on current fork main in legacy `server/src/services/shareService.ts` and
the older shared page. Fixing main first would require a second port after v4 integration, so it is
deliberately deferred to the v4 tree.

Security review also confirmed wildcard rows in days, assignments, day notes, places/categories,
reservations/accommodations, packing, budget and collab. They can expose parent/user/provider/sync/
audit or cross-flag data; global categories are queried even when `share_map=false`. `SHARE-01`
therefore covers a typed exact-key DTO for every anonymous response section, disabled-flag no-query
assertions and whole-response sentinels; it is not only a one-field UI patch.

The pinned page calls `resolveBasemap(null, OFM_POSITRON, cartoApiKey)`. A null user template always
selects the OFM fallback, so the current owner CARTO setting is unused in public rendering. The new
contract keeps only a compatibility `cartoApiKey: ''` field and prohibits reading/transmitting the
credential.

## Confirmed field and privacy contract

- `places.notes` is trip-scoped and has no owner/private field.
- `day_assignments.notes` is an internal assignment field and is omitted; `day_notes` and
  collaboration data remain separately gated and must not substitute for place notes.
- `share_map=true` already sends top-level `places[].notes` to an anonymous token holder.
- `share_map=false` encloses all days/assignments/dayNotes/places queries and returns empty shapes.
- Current English/Korean and other locale placeholders misleadingly describe `places.notes` as
  personal; copy and public-link disclosure are mandatory parts of the fix.
- v4 `share_manage` authorization is stronger than current main and must remain intact.
- Revoking a link must invalidate both its payload and token-scoped photo route; a reissued token must
  differ from the revoked value.

## Public DTO exact-key review ledger

These keys are derived from the pinned v4.1.1 public page plus its direct day/flight helpers. This is
the post-implementation exact-key regression ledger; every row was approved by the independent
security re-review before the local verification status was assigned.

| Section                     | Exact keys/value contract                                                                                                                                                          | Flag                | Review                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------- |
| root                        | `trip`, `baseCurrency`, `cartoApiKey`, `categories`, `permissions`, `days`, `assignments`, `dayNotes`, `places`, `reservations`, `accommodations`, `packing`, `budget`, `collab`   | always stable shape | APPROVED — security re-review 2026-09-01 |
| trip                        | `title`, `description`, `start_date`, `end_date`, `cover_image`, `currency`                                                                                                        | always              | APPROVED — security re-review 2026-09-01 |
| permissions                 | `share_map`, `share_bookings`, `share_packing`, `share_budget`, `share_collab`                                                                                                     | always              | APPROVED — security re-review 2026-09-01 |
| days                        | `id`, `day_number`, `title`, `date`                                                                                                                                                | map                 | APPROVED — security re-review 2026-09-01 |
| assignments                 | `id`, `order_index`, `place`; internal `notes` omitted                                                                                                                             | map                 | APPROVED — security re-review 2026-09-01 |
| nested place                | `id`, `name`, `description`, `lat`, `lng`, `address`, `category_id`, `place_time`, `end_time`, `image_url`, `notes`, `category`                                                    | map                 | APPROVED — security re-review 2026-09-01 |
| nested category             | `color`, `icon`                                                                                                                                                                    | map                 | APPROVED — security re-review 2026-09-01 |
| top-level place             | `id`, `name`, `lat`, `lng`, `category_color`, `category_icon`, `notes`                                                                                                             | map                 | APPROVED — security re-review 2026-09-01 |
| top-level category          | `id`, `color`; only trip-referenced rows                                                                                                                                           | map                 | APPROVED — security re-review 2026-09-01 |
| day note                    | `id`, `sort_order`, `text`, `time`                                                                                                                                                 | map                 | APPROVED — security re-review 2026-09-01 |
| reservation                 | `id`, `type`, `title`, `status`, `reservation_time`, `reservation_end_time`, `location`, `metadata`, `assignment_id`, `day_id`, `end_day_id`, `day_positions`, `day_plan_position` | bookings            | APPROVED — security re-review 2026-09-01 |
| reservation metadata        | `airline`, `flight_number`, `departure_airport`, `arrival_airport`, `train_number`, `platform`, `legs`; malformed becomes `{}`                                                     | bookings            | APPROVED — security re-review 2026-09-01 |
| reservation leg             | `from`, `to`, `airline`, `flight_number`, `train_number`, `platform`, `dep_day_id`, `dep_time`, `arr_day_id`, `arr_time`, `day_positions`                                          | bookings            | APPROVED — security re-review 2026-09-01 |
| accommodation               | `id`, `start_day_id`, `end_day_id`, `place_name`                                                                                                                                   | bookings            | APPROVED — security re-review 2026-09-01 |
| packing                     | `id`, `category`, `name`, `checked`; Common/non-private rows only                                                                                                                  | packing             | APPROVED — security re-review 2026-09-01 |
| budget                      | `id`, `category`, `name`, `total_price`, `currency`                                                                                                                                | budget              | APPROVED — security re-review 2026-09-01 |
| collab                      | `id`, `username`, `avatar`, `created_at`, `text`                                                                                                                                   | collab              | APPROVED — security re-review 2026-09-01 |
| scalar compatibility fields | `baseCurrency` uses owner setting only under budget, otherwise trip fallback; `cartoApiKey` is always `''` and never reads owner settings                                          | budget only         | APPROVED — security re-review 2026-09-01 |

Compact Tags, assignment notes, unused top-level place/category fields and every trip/parent/user/
provider/sync/audit/internal-linkage field are intentionally excluded. The only allowed time-like
fields are those listed above and rendered as itinerary, reservation, note or message time. Disabled
flags return the root's empty shape and issue no section query. Owner settings are fetched only for
enabled budget display currency; the CARTO setting is never read or sent. The excluded compact Tag
loader is never invoked. Release notes must identify this anonymous API minimization.

## Baseline tests

| Suite                                   | Result                                                | Why it misses the defect                                           |
| --------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| current fork server share-related tests | 2 files, 32 passed                                    | assert assignment note/name/coordinates, not nested place note     |
| current fork `SharedTripPage.test.tsx`  | 21 passed                                             | asserts names/address/description, not note detail                 |
| pre-implementation integrated RED       | failing assertions captured; exact count not retained | nested DTO, Popup/plan note and copy assertions exposed the defect |

Pre-existing server migration logs include non-fatal duplicate-column warnings. They are not evidence
for or against this defect.

## RED/GREEN ledger

| Contract                                                                                         | RED                                                         | Implementation                                                    | GREEN / final evidence                                                                                                    | State    |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------- |
| API exact DTO, both projections carry same place note; assignment note excluded                  | `failing assertion captured` (exact RED count not retained) | `server/src/nest/share/share.service.ts`, `public-share.types.ts` | `server/tests/unit/nest/share.service.test.ts` + `server/tests/integration/share.test.ts`: 74 passed across 2 files       | VERIFIED |
| `share_map=false` empty shape, no section queries, internal/provider/sync/audit sentinels absent | `failing assertion captured` (exact RED count not retained) | flag-gated query/DTO contract                                     | same 74 server tests; disabled flags and corrupt metadata fail closed                                                     | VERIFIED |
| revoked payload/photo and different-token reissue                                                | `failing assertion captured` (exact RED count not retained) | token/revocation contract retained                                | same 74 server tests                                                                                                      | VERIFIED |
| trip-wide and selected-day marker Popup; plan address/description plus separate note             | `failing assertion captured` (exact RED count not retained) | `SharedTripPage.tsx` map/plan renderers                           | 170 passed across 4 affected client files                                                                                 | VERIFIED |
| null/empty/long/Markdown/raw HTML safety and keyboard focus/return policy                        | `failing assertion captured` (exact RED count not retained) | safe Markdown + focus/keyboard behavior                           | 170 passed across 4 affected client files; Playwright public 4/4                                                          | VERIFIED |
| all locale copy means shared place note; public link disclosure                                  | `failing assertion captured` (exact RED count not retained) | 23 locale `places`/`share` entries and disclosure copy            | shared i18n test: 4 passed; independent semantic re-review: all 23 locales PASS; `TripMembersModal`: 58/58 fresh evidence | VERIFIED |

### Final command evidence

| Gate                       | Command                                                                                                                                                                                        | Result                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| server DTO/query/lifecycle | `ENCRYPTION_KEY=<synthetic-64-hex> npm run test --workspace=server -- --run tests/unit/nest/share.service.test.ts tests/integration/share.test.ts`                                             | 2 files, 74/74 passed                                  |
| affected client unit       | `npm run test --workspace=client -- --run src/App.test.tsx src/components/Trips/TripMembersModal.test.tsx src/components/shared/markdownLink.test.tsx src/pages/SharedTripPage.test.tsx`       | 4 files, 170/170 passed                                |
| disclosure focused         | `npm run test --workspace=client -- --run src/components/Trips/TripMembersModal.test.tsx`                                                                                                      | 58/58 passed                                           |
| locale semantics           | `npm run test --workspace=shared -- --run src/i18n/i18n-place-notes.spec.ts`                                                                                                                   | 1 file, 4/4 passed                                     |
| locale key parity          | `npm run i18n:parity:strict --workspace=shared`                                                                                                                                                | file/key parity OK                                     |
| source typing              | `npm run typecheck --workspace=client`; `npm run typecheck --workspace=shared`; `npm run typecheck --workspace=server`                                                                         | all exit 0                                             |
| browser                    | `TREK_E2E_BACKEND_PORT=33101 ENCRYPTION_KEY=<synthetic-64-hex> LOG_LEVEL=error npx playwright test e2e/shared-trip-place-notes.public.spec.ts --project=public --reporter=line` from `client/` | 4/4 passed; 1 focused negative-state rerun also passed |

Fresh binding on 2026-09-04 used place-note application source `200df8b4`: server 74/74, affected
client 170/170, shared locale 4/4 and public Playwright 4/4 all passed again. Public test cleanup and
anonymous map isolation were then hardened in `69f83999`; `3ee91284` owner-scopes the fallback
cleanup and proves another user's same-prefix trip survives. `a55fcccb` wraps the exact foreign
fixture in an outer `finally`, performs a next-run stale sweep, repeats cleanup in suite `afterAll`,
and self-checks cleanup after a synthetic normal exception. The public Playwright 4/4 passed on that
final checkpoint with synthetic tokens/trips/categories/boundary user all at zero after the run. It regenerated
the selected-day 1440px and 390px screenshots and they were visually inspected: nested place notes,
address separation, long-line wrapping, OpenFreeMap attribution and the absence of horizontal
overflow remain visible. The integrated checkpoint `a55fcccb` also contains normalized trip-share expiry but
does not change the `places.notes` projection or rendering contract.

## Browser evidence

| View/state                                                                                | Screenshot/artifact                                                  | Console/network                                                                                                                                                     | State    |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1440 all-days Popup                                                                       | `docs/screenshots/share-place-notes-1440-all-days.png`               | Playwright assertion: no console/page errors                                                                                                                        | VERIFIED |
| 1440 selected-day Popup and plan                                                          | `docs/screenshots/share-place-notes-1440-selected-day.png`           | Playwright assertion: no console/page errors                                                                                                                        | VERIFIED |
| 390 tap/close/wrapping                                                                    | `docs/screenshots/share-place-notes-390-selected-day.png`            | Playwright assertion: no console/page errors                                                                                                                        | VERIFIED |
| keyboard name/focus/Enter/close-button/Escape return, pointer no-jump, second-marker/link | `client/e2e/shared-trip-place-notes.public.spec.ts`                  | cookie-free `public` project; no console/page errors asserted                                                                                                       | VERIFIED |
| no-map/invalid/expired/revoked                                                            | same Playwright spec; all-flags-off asserts no Leaflet/map container | no-map has no console/page errors; negative links allow only their expected `/api/shared/:token` 404 resource messages and reject other console/page errors or 404s | VERIFIED |

All rows come from `client/e2e/shared-trip-place-notes.public.spec.ts` under Playwright's cookie-free
`public` project, final result 4/4 passed. The evidence covers Popup note rendering, separate plan
address/note, long-note wrapping, keyboard interaction, no-map state, and invalid/expired/revoked
states. An authenticated `app`-project screenshot does not satisfy this gate.

Final v4.1.1 checkpoint screenshot bindings:

| Artifact                                  | Dimensions | SHA-256                                                            |
| ----------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `share-place-notes-1440-all-days.png`     | 1440×919   | `3d250f0da0864971562fe4a0e0087f68a179e5d1c0c703227a7049e4da766ab7` |
| `share-place-notes-1440-selected-day.png` | 1440×1129  | `76ef6a13fe14d4ab87e9fd976a9aa7b33dbcebb6cd812c10f1553338e1c8db4e` |
| `share-place-notes-390-selected-day.png`  | 390×1208   | `284d3df4ec99ca471e7358f6e2c3bd9a190b14b332cb08052ec4441c2ff12cfe` |

## Locale semantic review ledger

Record the proposed locale-specific placeholder and public-link disclosure, reviewer and verdict.
Key parity alone is never a semantic PASS.

| Locale | Proposed text/reference                        | Reviewer                      | Verdict |
| ------ | ---------------------------------------------- | ----------------------------- | ------- |
| ar     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| br     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| ca     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| cs     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| de     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| en     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| es     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| fr     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| gr     | corrected translation, then semantic re-review | independent semantic reviewer | PASS    |
| hu     | corrected translation, then semantic re-review | independent semantic reviewer | PASS    |
| id     | corrected translation, then semantic re-review | independent semantic reviewer | PASS    |
| it     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| ja     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| ko     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| nl     | corrected translation, then semantic re-review | independent semantic reviewer | PASS    |
| pl     | corrected translation, then semantic re-review | independent semantic reviewer | PASS    |
| ru     | corrected translation, then semantic re-review | independent semantic reviewer | PASS    |
| sv     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| tr     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| uk     | corrected translation, then semantic re-review | independent semantic reviewer | PASS    |
| vi     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| zh-TW  | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |
| zh     | shared place note + public-link disclosure     | independent semantic reviewer | PASS    |

`TripMembersModal.test.tsx` separately proves the reviewed `share.linkHint` is visible where the owner
configures a public link; the fresh evidence is 58/58 passed. The independent semantic re-review
covered all 23 locales and marked them PASS after the initial `gr`, `id`, `hu`, `uk`, `nl`, `pl`, and
`ru` wording corrections.

## Adversarial review status

| Review                | Initial decision | Material correction                                                                                                   | Re-review                         |
| --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| UX/accessibility      | FAIL             | target-tag phase, public project, marker focus policy and locale ledger corrected                                     | PASS — final re-review 2026-09-01 |
| security/architecture | FAIL             | all-section exact DTO, unused CARTO credential/assignment-note removal, flag/query sentinels and revocation corrected | PASS — final re-review 2026-09-01 |

The independent final share re-review found and then closed two MED findings: persisted-auth side
effects on `/shared/*`, and the all-flags-off path potentially rendering a blank Plan map. The final
decision is `blockers 0 / proceed` for this local SHARE-01 integrated tree.

Final API evidence explicitly covers the exact DTO allowlist, flags-off no-query/empty-shape behavior,
never transmitting the CARTO credential, excluding internal assignment notes, and failing closed on
corrupt reservation metadata.

## Completion rule

SHARE-01 is `VERIFIED` in the local integrated tree and was freshly rebound on 2026-09-04: server
share unit/integration (74/74 across 2
files), affected client tests (170/170 across 4 files), shared i18n (4/4), client typecheck, public
Playwright (4/4), locale semantic review (23/23 PASS), disclosure (58/58), positive/negative API
sentinels, no unexpected console/page errors, and independent final review are recorded above. This
is local feature evidence only; the overall v4.1.1 release remains separate `NO-GO` until the restore
quiesce/crash-recovery and release rehearsal gates are resolved. No production or deployment claim is
made here. Official latest changed to v4.2.0 on 2026-09-03, so the same `SHARE-01` API/UI/browser
contract must pass again on the incremental v4.2.0 branch before any latest-version release claim.
