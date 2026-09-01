# Public Shared Place Notes Design

> 작성일: 2026-09-01
> 상태: v4.1.1 통합 후 구현 승인 후보
> 대상 baseline: 통합된 TREK v4.1.1 fork
> lane: `upstream-contrib` candidate, 현재 publication hold에서는 `fork-core` 검증 branch
> migration/dependency: 없음

All v4 paths in this design are pinned-tag paths verified with
`git show v4.1.1^{}:<path>`. The current pre-merge worktree still has a legacy delegating share
service; implementation starts only after the target tag has supplied the Nest owner and v4 client
helpers.

## User outcome

유효한 공개 여행 링크의 **지도 및 계획**에서 여행 장소에 저장한 공유 장소 메모를 볼
수 있어야 한다. 이 메모는 특정 사용자의 개인 메모가 아니며, `places.notes`라는 여행
단위 장소 데이터다.

주소나 설명이 있어도 메모가 별도로 보여야 한다. 지도에서는 click/tap/keyboard로
유지되는 상세 Popup, 계획에서는 장소 행의 별도 메모 block을 사용한다.

## Diagnosis

결함은 현재 fork와 upstream v4.1.1 모두에 있다.

```text
places.notes
  ├─ trip-wide SELECT p.* ───────────────> places[].notes present
  │                                       └─ all-days map renders name only
  └─ assignment SELECT ... AS place_notes
       └─ assignment.place constructor drops notes
          ├─ selected-day map cannot receive note
          └─ plan row cannot receive/render note
```

v4.1.1 `server/src/nest/share/share.service.ts`는 `p.notes AS place_notes`를 조회하지만
`assignment.place`를 구성할 때 `notes`를 누락한다. 같은 service의 trip-wide place query는
`p.*`를 반환하므로 익명 응답의 `places[].notes`에는 이미 메모가 들어간다.

v4.1.1 `client/src/pages/SharedTripPage.tsx`는:

- 전체 일정 지도에서 top-level `places[]`를 사용하지만 Marker Tooltip에는 이름만 표시한다.
- 선택일 지도와 계획에서는 메모가 빠진 `assignment.place`를 사용한다.
- 계획 행에는 `address || description`만 표시한다.

따라서 원인은 서버 projection 누락과 클라이언트 표시 누락의 조합이며 신뢰도는 높다.

## Privacy and naming correction

`places.notes`에는 `user_id`, `owner_id`, `is_private`가 없다. 기본 `place_edit` 권한을 가진
여행 구성원이 편집하는 trip-shared field다. 별도의 개인 장소 메모 field는 현재 schema에
없다.

그러나 23개 locale의 `places.formNotesPlaceholder`는 모두 “Personal notes/개인 메모”와
동등한 표현을 사용한다. 실제 권한·공개 API와 모순된다. `share_map=true`인 링크에서는
이미 raw JSON의 top-level places를 통해 이 값이 익명 수신자에게 전달될 수 있다.

그러므로 화면 표시만 추가하는 변경은 허용하지 않는다. 같은 변경에서:

1. 모든 locale의 placeholder를 “장소 메모” 의미로 수정한다.
2. 공개 링크 `Map & Plan`에 장소/일정 메모가 포함된다는 설명을 `share.linkHint` 또는
   별도 description key로 명시한다.
3. 정말 개인 장소 메모가 필요하면 owner/visibility, migration, ACL과 별도 public DTO가
   필요한 별도 기능으로 설계한다. 이번 범위에서는 만들지 않는다.

## Note field contract

| Field                           | Meaning                                 | This change                                         |
| ------------------------------- | --------------------------------------- | --------------------------------------------------- |
| `places.notes`                  | trip-shared place note; requested field | project into both place shapes and render           |
| `day_assignments.notes`         | internal note about one assignment      | omit from anonymous DTO; never render as place note |
| `days.notes`                    | legacy/single day row note              | no new behavior                                     |
| `day_notes`                     | timeline note cards                     | preserve existing public rendering                  |
| `collab_notes`                  | authored collaboration notes            | service does not expose; no change                  |
| `collab_messages`               | collaboration chat                      | only `share_collab=true`; no change                 |
| packing private/restricted data | actual owner/recipient visibility model | no change; public share remains Common-only         |

Sentinel-based tests use different values for each field. A UI selector or assertion scoped to a place
detail must never match internal assignment, day-note or collab sentinels.

## Public DTO invariants

For a valid share token:

```text
share_map=true:
  places[id].notes === assignments[*][*].place[id].notes

share_map=false:
  days = []
  assignments = {}
  dayNotes = {}
  places = []
  serialized response contains no place-note sentinel
```

`notes` is required-nullable in the public place projection: present with `string | null` rather than
silently omitted in one shape. This change must also replace **every wildcard row projection inside
`getSharedTripData`** with an explicit typed projection/allowlist. The contract covers every response
section, not only Place/Category. The exact v4.1.1 consumer-derived key table is:

| Section                       | Exact public keys                                                                                                                                                                  | Owning flag / reason                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| root                          | `trip`, `baseCurrency`, `cartoApiKey`, `categories`, `permissions`, `days`, `assignments`, `dayNotes`, `places`, `reservations`, `accommodations`, `packing`, `budget`, `collab`   | stable root shape                                                       |
| `trip`                        | `title`, `description`, `start_date`, `end_date`, `cover_image`, `currency`                                                                                                        | public header and budget fallback; unused internal trip ID excluded     |
| `permissions`                 | `share_map`, `share_bookings`, `share_packing`, `share_budget`, `share_collab`                                                                                                     | tab/empty-state gating                                                  |
| `days[]`                      | `id`, `day_number`, `title`, `date`                                                                                                                                                | `share_map`; picker, header and ordering                                |
| `assignments[day][]`          | `id`, `order_index`, `place`                                                                                                                                                       | `share_map`; internal assignment note and grouped parent ID are omitted |
| nested `place`                | `id`, `name`, `description`, `lat`, `lng`, `address`, `category_id`, `place_time`, `end_time`, `image_url`, `notes`, `category`                                                    | `share_map`; map/plan only                                              |
| nested `place.category`       | `color`, `icon`                                                                                                                                                                    | `share_map`; marker rendering                                           |
| top-level `places[]`          | `id`, `name`, `lat`, `lng`, `category_color`, `category_icon`, `notes`                                                                                                             | `share_map`; all-days map/Popup                                         |
| `categories[]`                | `id`, `color`                                                                                                                                                                      | `share_map`; only trip-referenced categories, plan colour lookup        |
| `dayNotes[day][]`             | `id`, `sort_order`, `text`, `time`                                                                                                                                                 | `share_map`; timeline/display                                           |
| `reservations[]`              | `id`, `type`, `title`, `status`, `reservation_time`, `reservation_end_time`, `location`, `metadata`, `assignment_id`, `day_id`, `end_day_id`, `day_positions`, `day_plan_position` | `share_bookings`; booking card/timeline                                 |
| reservation `metadata`        | `airline`, `flight_number`, `departure_airport`, `arrival_airport`, `train_number`, `platform`, `legs`                                                                             | sanitized object, never raw JSON passthrough                            |
| reservation `metadata.legs[]` | `from`, `to`, `airline`, `flight_number`, `train_number`, `platform`, `dep_day_id`, `dep_time`, `arr_day_id`, `arr_time`, `day_positions`                                          | `share_bookings`; multi-leg display/order only                          |
| `accommodations[]`            | `id`, `start_day_id`, `end_day_id`, `place_name`                                                                                                                                   | `share_bookings`; day-range chip                                        |
| `packing[]`                   | `id`, `category`, `name`, `checked`                                                                                                                                                | `share_packing`; Common/non-private rows only                           |
| `budget[]`                    | `id`, `category`, `name`, `total_price`, `currency`                                                                                                                                | `share_budget`; display only, no payer/linkage                          |
| `collab[]`                    | `id`, `username`, `avatar`, `created_at`, `text`                                                                                                                                   | `share_collab`; rendered identity/text/time                             |

The table intentionally removes undocumented fields that the pinned public page and its direct merge/
flight helpers do not consume, including compact Tags, assignment notes, unused top-level place
description/address/category/image fields, trip/parent/user IDs, provider identifiers,
confirmation/internal booking notes, packing ownership, budget payer data, sync state and audit
timestamps. This is an explicit anonymous API minimization change and must be called out in release
notes; do not silently restore an unused field for compatibility. User-visible schedule/message
fields (`start_date`, `end_date`, `date`, `place_time`, `end_time`, reservation times, day-note `time`,
collab `created_at`) are the only time-field exceptions.

The root shape stays stable when a flag is off, but its value is empty (`[]`/`{}`/empty string).
`baseCurrency` uses the owner setting only when `share_budget=true`, otherwise the already-public trip
currency fallback. `cartoApiKey` remains in the stable root shape but is always `''`; the public page
passes a null user template to `resolveBasemap`, so the key cannot affect its OFM fallback and the
owner CARTO credential must never be read or transmitted. Each disabled data section issues no
section query. Owner settings are fetched only when budget is enabled and only for display currency.
Reservation metadata is parsed defensively, copied through the nested allowlist and returned as a
sanitized object; malformed input becomes `{}`.
Because Tags are absent from the contract, the share service also removes its compact Tag query and
`QueryHelpersService` dependency; querying then discarding those rows is not acceptable evidence.

Define every response section in the v4 share module and use explicit SQL columns/object constructors.
Before source edits, copy this table to the evidence ledger and obtain independent security approval.
No `SELECT *`, `alias.*` or unreviewed object spread may remain in the public data method. Do not defer
this to a later hardening task.

Invalid, expired and revoked tokens return no trip payload. The place-photo proxy continues to reject
`share_map=false` and invalid tokens. v4's `share_manage` requirement for creating/reading link state
must not regress.

## UI behavior

### Map

- Keep the existing lightweight Tooltip for the place name.
- Add a Marker `Popup` containing the place name and non-empty `places.notes`.
- Set the Marker `title` to the place name so Leaflet's focusable `role=button` has a discernible
  accessible name; preserve a visible focus indicator for the custom `divIcon`.
- Popup is chosen for persistent detail, close affordance and long-content interaction. The existing
  Tooltip is not strictly hover-only—it also has click/focus interactions—but closes on mouseout and
  is a poor container for multiline Markdown.
- The same component behavior covers trip-wide markers and selected-day markers; the server projection
  guarantees both inputs carry notes.
- Popup maximum height is bounded and scrollable. Content uses `overflowWrap: anywhere`.

### Plan

- Keep the name line.
- Keep `address || description` as its existing secondary line.
- Render a **separate** note block below it when trimmed notes are non-empty.
- Never use `address || description || notes`; an address must not hide the note.
- Do not return, label or render `assignment.notes` in the anonymous payload.

### Markdown and links

Reuse `client/src/components/shared/markdownLink.tsx` and its tests from the integrated v4.1.1
baseline with `react-markdown`, `remark-gfm` and `remark-breaks`. Verify both paths in the merged tree
before Task 4; their absence in the pre-merge fork is expected. Do not enable raw HTML. Preserve and verify
react-markdown's default safe URL transform:

- raw `<script>` is inert and creates no executable node;
- HTTP(S), relative/hash and the currently accepted `mailto`/IRC(S)/XMPP schemes remain navigable;
- `javascript:`, `data:`, `file:` and malformed scheme-bearing links get no navigable target;
- note links keep `target="_blank"` and `rel="noopener noreferrer nofollow"`;
- multiline lists/line breaks render without horizontal overflow.

No new production dependency is required.

## State matrix

| State                             | Map detail                      | Plan row                     | Expected                          |
| --------------------------------- | ------------------------------- | ---------------------------- | --------------------------------- |
| note `null`/empty/whitespace      | name only                       | no empty note block          | no extra vertical gap             |
| note only                         | Popup note                      | note block                   | visible in both                   |
| address + description + note      | Popup note                      | address fallback line + note | both secondary data types visible |
| all-days map                      | top-level `places.notes`        | all day cards as expanded    | correct note                      |
| selected-day map                  | nested `assignment.place.notes` | selected day row             | correct nested note               |
| same place assigned twice         | one marker with order badge(s)  | both assignment rows         | same shared place note            |
| dangling assignment               | no marker/row crash             | row skipped as before        | no regression                     |
| long Korean/English/no-space note | scroll/wrap                     | wrap, no x-overflow          | readable at 390/1440              |
| Markdown and safe link            | persistent Popup                | rendered note                | keyboard/touch usable             |
| raw HTML/script                   | inert text/omitted HTML         | inert                        | no execution                      |
| `share_map=false`                 | no plan/map                     | no row                       | sentinel absent from JSON         |
| invalid/expired token             | error state                     | error state                  | no data                           |
| revoked token                     | old link and photo fail closed  | error state                  | reissued token differs            |

## Accessibility and responsive contract

### Keyboard

- Marker remains focusable through Leaflet's interactive marker behavior.
- Its accessible name is the place name and its focus indicator remains visible.
- Enter/keypress opens the Popup. Store the keyboard opener's Leaflet marker element by place ID;
  close-button and Escape paths restore focus to it after Popup removal.
- Pointer/touch close does not steal focus. Opening another marker must not restore focus to the old
  opener.
- Links inside the note have discernible text and visible focus.
- Popup must not create a keyboard trap.

### Touch/mobile

- At 390×844, marker tap opens the persistent Popup and close/another-marker behavior works.
- Popup stays inside the viewport or is pannable through Leaflet's default auto-pan.
- Long note and link do not force page-level horizontal scroll.

### Desktop

- At 1440×900, quick hover name Tooltip and click detail do not conflict.
- Selected-day filtering/refit retains the correct nested note.

## API and security acceptance criteria

1. Anonymous `GET /api/shared/:token` with `share_map=true` returns the same place note in top-level
   and assignment projections.
2. `day_assignments.notes` is absent from the anonymous DTO and never substitutes for `places.notes`.
3. `share_map=false` response serialization contains no place-note sentinel anywhere.
4. Invalid, expired and revoked tokens expose no note or photo proxy.
5. Every public response section uses an exact allowlist. Disabled flags trigger no query and return
   the documented empty shape. Parent/user/provider/sync/audit fields are absent; only reviewed
   user-visible schedule/message times remain under their owning flag.
6. The owner CARTO setting is never queried or transmitted; compatibility `cartoApiKey` is always
   `''`. Owner settings are read only for display currency when `share_budget=true`.
7. Revocation invalidates the old payload and photo URL; a subsequent link uses a different token.
8. Public link state management still requires v4 `share_manage`; a normal trip member cannot mint or
   inspect a token unless permission settings explicitly allow it.
9. React rendering escapes raw HTML and preserves current safe-link policy.

## Test design

### Server unit

`server/tests/unit/nest/share.service.test.ts`:

- `SHARE-SVC-032`: place sentinel appears in both public place projections while the internal
  assignment-note sentinel is absent from the entire serialized payload.
- `SHARE-SVC-033`: exact root/trip/day/assignment/day-note/Place/Category keys exclude compact Tags
  and internal/provider/booking sentinels; the Tag loader is not called; `share_map=false` returns no
  map-related rows/key.
- `SHARE-SVC-033b`: exact reservation/accommodation/packing/budget/collab keys and flag-off query
  spies exclude cross-flag, owner, provider, sync and audit sentinels; CARTO settings are never read
  and budget settings are read only under the budget flag.
- `SHARE-SVC-034`: old token payload/photo fail closed after revocation and reissue differs.
- Extend no-map coverage to assert the serialized response does not contain a place sentinel.

### Server integration

`server/tests/integration/share.test.ts`:

- `SHARE-030`: anonymous token returns both place projections with the same note.
- `SHARE-031`: exact anonymous DTO keys for every response section and cross-share-flag negative
  sentinels/query spies.
- `SHARE-032`: payload/photo revocation lifecycle and different reissued token.
- Extend `SHARE-024` with a no-map sentinel negative assertion.
- Preserve invalid/expired and photo-proxy negative tests.

### Client

`client/src/pages/SharedTripPage.test.tsx`:

- `FE-PAGE-SHARED-042`: trip-wide Popup and expanded plan row show a note while address remains.
- `FE-PAGE-SHARED-043`: selected day reads nested note, not a different top-level sentinel.
- `FE-PAGE-SHARED-044`: place/assignment/day/collab sentinels stay semantically separate.
- `FE-PAGE-SHARED-045`: null, whitespace, multiline, long, Markdown and raw-script states are safe.
- `FE-PAGE-SHARED-046`: both marker shapes receive the place-name `title` and retain focus styling.
- `FE-PAGE-SHARED-047`: mocked marker refs and events distinguish keyboard from pointer close,
  restore only the current keyboard opener and clear stale opener/listeners.
- Extend target v4 `markdownLink.test.tsx` with unsafe-scheme and rel-policy assertions.
- Add a `Popup` entry to the react-leaflet test mock; real focus behavior remains an E2E assertion.

### E2E

Add `client/e2e/shared-trip-place-notes.public.spec.ts`, which matches the target v4 Playwright
`public` project and never loads `e2e/.tmp/state.json`:

- public/no-cookie 1440×900 all-days and selected-day Popup screenshots;
- 390×844 marker tap/close, wrapping and plan-row screenshot;
- marker accessible name and visible focus; Enter open; keyboard close-button and Escape focus return;
  pointer/touch close without forced focus; second-marker stale-opener rejection; link navigation;
- network assertions for same-note projections and no-map sentinel absence;
- console error, page error and React warning count zero.

## Copy and locale gate

Affected globs after v4 integration:

- `shared/src/i18n/*/places.ts`: `places.formNotesPlaceholder`
- `shared/src/i18n/*/share.ts`: disclosure text

All 23 locales must express **place/trip-shared notes**, not personal/private ownership. Keep the
existing keys when the copy fits to avoid unnecessary key churn. The evidence ledger records each
locale's proposed text, reviewer and verdict; strict key/placeholder parity alone cannot detect a
mistranslation. A client regression test also proves `share.linkHint` renders in
`TripMembersModal.tsx`, not merely that the key exists.

Required automated gates:

```bash
npm --workspace shared run i18n:parity:strict
npm --workspace shared run typecheck
npm --workspace shared test
```

## Evidence

Evidence is written to
[`2026-09-01-public-share-place-notes-evidence.md`](2026-09-01-public-share-place-notes-evidence.md).
It must bind RED and GREEN output, API payload assertions, screenshots, console/network evidence and
final SHA. Screenshots from a different tree or before copy/privacy fixes do not count.

## Rollback

The feature itself is code-only and adds no schema or dependency. Before deployment, rollback is
branch/worktree discard. After deployment on the v4 candidate, rollback follows the v4 release
rollback as a whole; the note patch does not justify running old code against schema 200 without the
release's tested compatibility/restore decision.
