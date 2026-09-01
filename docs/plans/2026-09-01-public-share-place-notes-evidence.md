# Public Shared Place Notes Evidence

> 작성일: 2026-09-01
> 상태: root cause and plan verified; implementation not started
> target baseline: future integrated v4.1.1 fork
> preservation ID: `SHARE-01`

## Confirmed root cause

| Surface            | v4.1.1 evidence                                         | Finding                                      |
| ------------------ | ------------------------------------------------------- | -------------------------------------------- | --- | ---------------------- |
| server query       | `server/src/nest/share/share.service.ts` around 178–190 | reads `p.notes AS place_notes`               |
| nested projection  | same file around 195–208                                | drops `notes` from `assignment.place`        |
| trip-wide pool     | same file around 221–225                                | `SELECT p.*` already includes `places.notes` |
| selected-day input | `client/src/pages/SharedTripPage.tsx` around 159–179    | uses nested assignment places                |
| map output         | same file around 518–522                                | renders only name Tooltip                    |
| plan output        | same file around 796–850                                | renders name and `address                    |     | description`, not note |

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

These keys are derived from the pinned v4.1.1 public page plus its direct day/flight helpers. Source
implementation must not start until an independent security reviewer marks every row approved.

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

| Suite                                   | Result             | Why it misses the defect                                       |
| --------------------------------------- | ------------------ | -------------------------------------------------------------- |
| current fork server share-related tests | 2 files, 32 passed | assert assignment note/name/coordinates, not nested place note |
| current fork `SharedTripPage.test.tsx`  | 21 passed          | asserts names/address/description, not note detail             |
| v4.1.1 integrated tests                 | not run            | integration tree does not exist yet                            |

Pre-existing server migration logs include non-fatal duplicate-column warnings. They are not evidence
for or against this defect.

## RED/GREEN ledger

| Contract                                                                             | RED | Implementation | GREEN | State   |
| ------------------------------------------------------------------------------------ | --- | -------------- | ----- | ------- |
| both public projections carry same place note                                        | —   | —              | —     | PENDING |
| internal assignment note absent from the full response                               | —   | —              | —     | PENDING |
| `share_map=false` serialized sentinel absence                                        | —   | —              | —     | PENDING |
| exact anonymous keys for every root/nested section                                   | —   | —              | —     | PENDING |
| disabled-flag no-query/empty shape and internal/provider/sync/audit sentinel absence | —   | —              | —     | PENDING |
| revoked payload/photo + different-token reissue                                      | —   | —              | —     | PENDING |
| trip-wide marker Popup                                                               | —   | —              | —     | PENDING |
| selected-day nested marker Popup                                                     | —   | —              | —     | PENDING |
| plan address/description + separate note                                             | —   | —              | —     | PENDING |
| null/empty/long/Markdown/raw HTML safety                                             | —   | —              | —     | PENDING |
| all locale copy means shared place note                                              | —   | —              | —     | PENDING |
| public link disclosure                                                               | —   | —              | —     | PENDING |
| Marker accessible name/focus/current-opener return policy                            | —   | —              | —     | PENDING |

## Browser evidence

| View/state                                                                                | Screenshot/artifact | Console/network | State   |
| ----------------------------------------------------------------------------------------- | ------------------- | --------------- | ------- |
| 1440 all-days Popup                                                                       | —                   | —               | PENDING |
| 1440 selected-day Popup and plan                                                          | —                   | —               | PENDING |
| 390 tap/close/wrapping                                                                    | —                   | —               | PENDING |
| keyboard name/focus/Enter/close-button/Escape return, pointer no-jump, second-marker/link | —                   | —               | PENDING |
| no-map/invalid/expired/revoked                                                            | —                   | —               | PENDING |

All browser rows must come from `client/e2e/shared-trip-place-notes.public.spec.ts` under Playwright's
cookie-free `public` project. An authenticated `app`-project screenshot does not satisfy this gate.

## Locale semantic review ledger

Record the proposed locale-specific placeholder and public-link disclosure, reviewer and verdict.
Key parity alone is never a semantic PASS.

| Locale | Proposed text/reference | Reviewer | Verdict |
| ------ | ----------------------- | -------- | ------- |
| ar     | —                       | —        | PENDING |
| br     | —                       | —        | PENDING |
| ca     | —                       | —        | PENDING |
| cs     | —                       | —        | PENDING |
| de     | —                       | —        | PENDING |
| en     | —                       | —        | PENDING |
| es     | —                       | —        | PENDING |
| fr     | —                       | —        | PENDING |
| gr     | —                       | —        | PENDING |
| hu     | —                       | —        | PENDING |
| id     | —                       | —        | PENDING |
| it     | —                       | —        | PENDING |
| ja     | —                       | —        | PENDING |
| ko     | —                       | —        | PENDING |
| nl     | —                       | —        | PENDING |
| pl     | —                       | —        | PENDING |
| ru     | —                       | —        | PENDING |
| sv     | —                       | —        | PENDING |
| tr     | —                       | —        | PENDING |
| uk     | —                       | —        | PENDING |
| vi     | —                       | —        | PENDING |
| zh-TW  | —                       | —        | PENDING |
| zh     | —                       | —        | PENDING |

`TripMembersModal.test.tsx` must separately prove that the reviewed `share.linkHint` is visible where
the owner configures a public link.

## Adversarial review status

| Review                | Initial decision | Material correction                                                                                                   | Re-review                         |
| --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| UX/accessibility      | FAIL             | target-tag phase, public project, marker focus policy and locale ledger corrected                                     | PASS — final re-review 2026-09-01 |
| security/architecture | FAIL             | all-section exact DTO, unused CARTO credential/assignment-note removal, flag/query sentinels and revocation corrected | PASS — final re-review 2026-09-01 |

## Completion rule

Do not mark this feature complete until the final integrated SHA has fresh server unit/integration,
client unit, shared i18n and Playwright evidence; positive and negative API sentinels; locale semantic
review; no console/page errors; and independent specification/security review. Current state is plan
remediation only, not an implemented or visually verified feature.
