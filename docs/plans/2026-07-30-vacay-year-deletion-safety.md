# Vacay Year Deletion Safety Plan

> **Status:** local R0.2 implementation and verification complete; not pushed,
> merged, or deployed
>
> **Scope:** make the legacy calendar-year delete command actor-aware,
> fail-closed around shared or ambiguous ownership, atomic, and usable from
> keyboard and touch. This is not a Vacay v2 leave-period delete design.

## Problem

At the R0.1 baseline, `deleteYear(planId, year)` deleted the selected plan year's
`vacay_years`, every user's `vacay_entries` and `vacay_user_years`, manual
company holidays, and then changes the next year's carry. REST, MCP, and the web
UI let any accepted fusion member invoke it. The statements are independent
autocommits, so a mid-command failure can leave a partially deleted year.

The existing year control is also a 14 px hover-only `span`. Touch and keyboard
users cannot reliably discover or operate it, and the confirmation flow has no
single-flight or failure state.

## Review Decision

Three read-only reviewers covered Korean leave-domain semantics, architecture
and security, and responsive UX. The initial and post-implementation adversarial
rounds converged on these decisions:

- A fused plan is never allowed to remove a year. Owner, accepted member, and
  server admin receive no bypass.
- An actor-aware command resolves the active plan again inside an immediate
  SQLite transaction. REST and MCP must not pass a caller-selected `planId`.
- A nominal solo plan is still rejected as `review_required` when deleting the
  target could remove another user's row, when dependent rows exist without the
  year row, or while that target plan has an outgoing pending invitation.
- The outgoing-pending boundary is intentionally stricter than the R0.1 company
  holiday toggle boundary. `acceptInvite()` migrates all invitee entries and
  user-year rows, so deleting a target-plan year before acceptance can otherwise
  create data for a year absent from the target plan's year list.
- Unrelated foreign rows in other years, actor rows in another plan, and
  "latest year only" restrictions are not part of R0.2. They do not make this
  command delete another user's target-year data and would unnecessarily remove
  existing legacy behavior.
- Owner-only fused deletion was rejected because plan ownership does not confer
  ownership of another person's leave history. Per-user archive/delete and
  unanimous shared deletion remain Vacay v2 options.

## Domain and API Contract

The command is `deleteActiveYear(actorUserId, year, socketId)`.

Within one `db.transaction(...).immediate()` it must:

1. resolve the actor's accepted membership cardinality and active plan without
   creating a plan as a side effect;
2. reject multiple accepted memberships or an unknown membership state as
   `VACAY_YEAR_DELETE_REVIEW_REQUIRED`;
3. reject a non-owner or any plan with an accepted member as
   `VACAY_FUSED_YEAR_DELETE_READ_ONLY`;
4. detect whether the target `vacay_years` row and dependent entry, user-year,
   and company-holiday rows exist;
5. return an unchanged year list without notification when neither the year nor
   dependent rows exist;
6. reject orphan dependent rows, an outgoing pending invite, or target-year
   entry/user-year rows owned by somebody else as
   `VACAY_YEAR_DELETE_REVIEW_REQUIRED`;
7. delete the four target-year row sets and recompute every existing contiguous
   successor year's carry projection in order; and
8. return `{ years, changed: true }`.

Only after a successful commit does the public command make one best-effort
`vacay:settings` notification attempt. This is post-commit at-most-once
delivery, not durable exactly-once delivery. A rejection, no-op, or SQL failure
sends none.

REST accepts only a canonical safe integer path segment. It returns:

- `400` / `VACAY_INVALID_YEAR` for malformed values such as `2026junk`;
- `409` / `VACAY_FUSED_YEAR_DELETE_READ_ONLY` for accepted fusion;
- `409` / `VACAY_YEAR_DELETE_REVIEW_REQUIRED` for ambiguous legacy state; and
- `200 { years }` for a committed delete or a true no-op.

The REST add-year body and service add/delete commands also require a safe
integer, so every stored year can be addressed by the delete contract. No fixed
year range is introduced because the current schema does not enforce one. MCP
retains its existing add-year range and safe-integer delete schema and returns
the same domain code in an explicit tool error. Plugin RPC has no year-delete
method and will not gain one in this slice.

## UI State Matrix

| State | Year management | Confirmation |
| --- | --- | --- |
| solo, at least two years | selected-year, full-width 44 px button | destructive alert dialog |
| accepted fusion | disabled with visible read-only reason | never opens |
| outgoing invite pending | disabled with visible pending reason | never opens |
| solo → fused while open | control becomes read-only | closes and announces the state change |
| request pending | trigger/cancel/close disabled, one request, busy text | remains open |
| request failed | control re-enabled, latest plan is reloaded best-effort | explicit uncertain-result alert, retry available |
| request succeeded | year list and selection update | closes and restores stable focus |

The year tiles become real buttons. The destructive trigger uses an outline
danger treatment rather than a tiny solid-red badge. The shared Modal primitive
gets only the optional alert-dialog semantics needed here; a full focus trap and
global modal refactor remain separate work.

## Implementation and Test-First Evidence

- Service RED tests fixed owner/member rejection, outgoing pending,
  post-dissolve-style foreign user-year state, orphan state, true no-op,
  transaction rollback via failing SQLite triggers, adjacent-plan/year
  preservation, notification counts, safe-integer input, corrupted membership,
  deleted-source stats contamination, and multi-year carry propagation.
- Controller, REST integration, and MCP tests fix actor forwarding, canonical
  integer validation, stable `409` codes, and unchanged fused/pending rows at
  each public boundary.
- Component tests fix semantic year buttons, fused/pending disablement, live
  transition announcements, single-flight, uncertain-result refresh and real
  retry, alert-dialog semantics, and focus entry/return.
- The Vacay Playwright scenario covers direct REST rejection and fresh `1440`,
  `390`, and `884` responsive UI paths. The mobile/tablet path verifies initial
  close-button focus, a 44 px target, Escape/X/backdrop dismissal, trigger focus
  restoration, and horizontal containment. `884` is a regression viewport, not
  a Fold 7 device certification.

## Verification Evidence

The final 2026-07-30 local gate produced:

- all three post-implementation domain, architecture, and product/UX reviewers
  passed the R0.2 slice with no unresolved blocker;
- shared build, 34 files / 141 tests, typecheck, and strict file/key i18n parity
  passed;
- server 304 files / 5,463 tests and typecheck passed with two workers;
- client 206 files / 3,465 tests passed, 38 tests were skipped by the existing
  suite, and typecheck plus page-pattern validation passed;
- Playwright setup plus the Vacay scenario passed 2/2 against a real local
  server in 57.4 seconds, including REST rejection and the `1440`, `390`, and
  `884` paths; and
- the root shared/server/client production build and `git diff --check` passed.

Changed-path lint has zero errors. Existing warnings remain: the broader server
slice reports 42 warnings, the broader client slice reports 32 warnings, and
the touched Transit modal test accounts for two existing `no-explicit-any`
warnings. The production build also retains the repository's existing large
chunk and ineffective dynamic-import warnings.

The first unconstrained server full-suite attempt was externally terminated
with exit 143 before it produced a test result. A resource-constrained rerun
completed all 5,463 tests. The first client full-suite pass exposed an outdated
single-`Close` test assumption after the shared modal gained an accessible
header close label; the assertion was corrected to require both valid close
controls and the final full suite passed. The first expanded browser run
measured the drawer during its CSS entrance animation; the test now awaits the
animation rather than sleeping and the final browser gate passed.

## Adversarial Follow-up Decisions

The post-implementation review found and closed four material gaps:

1. carry is a chain, so every contiguous successor is recalculated in the same
   immediate transaction and a later failure rolls the entire command back;
2. reading stats for a deleted source year cannot recreate the successor's
   default carry;
3. add and delete share a safe-integer year contract; and
4. `NULL`, unknown, dangling, or multiple accepted membership states fail
   closed as `VACAY_YEAR_DELETE_REVIEW_REQUIRED`.

Two concerns remain intentionally separate:

- `acceptInvite()` can later migrate an invitee's historical user-year or entry
  into a target plan whose corresponding `vacay_years` row was previously
  removed. R0.2 blocks deletion while an invite is already pending, but does
  not define the future `delete → invite → accept` reconciliation policy.
- `getStats()` still has legacy write-through carry behavior for an existing
  source year. R0.2 prevents deleted-source recontamination; the broader
  pure-read/fresh-projection conversion remains its own correctness change.

## Rollback and Non-goals

There is no schema, migration, dependency, environment, or provider change.
Rollback is code-only. Deletion that has already committed is not recoverable by
reverting code, so production deployment still requires the normal database
backup/restore readiness check.

R0.2 does not repair dissolve/rejoin rows, reconcile the future invite-accept
year union, make all stats reads pure, migrate company holidays to employment
ownership, model fiscal/anniversary leave periods, add HR/admin authority, add a
delete preview/audit log, or expose year deletion to plugins.
