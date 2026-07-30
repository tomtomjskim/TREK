# Vacay Fused Company Holiday Guard Implementation Plan

> **Status:** local implementation and verification complete; not pushed,
> merged, or deployed
>
> **Scope:** R0.1 compatibility guard for the current plan-scoped company
> holiday model. This is not the user/employment ownership migration.

## Goal

Prevent a fused Vacay plan from accepting manual company-holiday changes while
preserving existing rows and all solo-plan behavior. The same rule must hold for
REST, MCP, plugin RPC, and the responsive web UI.

## Product and Permission Contract

- A plan is fused when `getPlanUsers(planId)` returns more than one user. Pending
  invitations do not count.
- Solo plans can continue to toggle manual company holidays and
  `company_holidays_enabled`.
- Fused plans reject both mutations before a database write, balance
  recalculation, or websocket broadcast.
- Existing company-holiday rows remain readable. Their current plan-wide
  non-deduction projection is retained for compatibility.
- Public-holiday calendars and all unrelated Vacay settings remain editable.
- REST returns HTTP `409` with the stable code
  `VACAY_FUSED_COMPANY_HOLIDAYS_READ_ONLY`.
- MCP returns a tool error. Plugin RPC maps the same domain error to
  `RESOURCE_FORBIDDEN`.
- The calendar and settings UI expose the existing values as read-only when a
  plan is fused. A live solo-to-fused transition also clears company-edit mode.

## Selected Design

Put one typed domain guard in the legacy Vacay service, immediately before each
company-holiday mutation. Thin adapters translate that error without duplicating
the fused-plan rule.

Alternatives rejected for R0.1:

- Owner-only editing still applies one person's employer calendar to every fused
  member.
- UI-only disabling can be bypassed through REST, MCP, or plugin RPC.
- Migrating rows to user/employment ownership now would require schema,
  backfill, and compatibility decisions that belong to Vacay v2.

## Architecture Readiness

| Surface | Change | Evidence |
| --- | --- | --- |
| Core service | typed error and pre-write guard | unit tests verify rows and settings do not change |
| REST | map domain error to stable `409` contract | integration tests |
| MCP | preserve domain rejection as tool error | MCP tool test |
| Plugin host | map domain error to `RESOURCE_FORBIDDEN` | RPC host test |
| Calendar UI | disable company mode and guard live transitions | component tests at state level |
| Settings UI | disable only the company-holiday toggle and explain read-only state | component tests |

No schema, dependency, environment, provider, scheduler, or deployment change is
required. Rollback is code-only; no data repair or backfill is needed.

## Implementation Tasks

1. Add failing service tests for fused toggle and setting updates, plus a pending
   invitation boundary test.
2. Add failing REST, MCP, and plugin RPC contract tests.
3. Implement the typed core error and adapter mappings.
4. Add failing calendar and settings read-only tests, including a live
   solo-to-fused transition.
5. Implement the minimal UI states using existing translation strings and design
   tokens.
6. Run focused tests, related suites, typechecks, and responsive browser checks.
7. Update the fork patch inventory and ownership decision with the implemented
   R0.1 boundary.

## Verification Evidence

- Service, REST, MCP, plugin RPC, calendar, and settings RED tests first failed
  on the intended missing guard/read-only behavior.
- Focused GREEN: 164 server tests and 33 client component tests passed.
- Related Vacay GREEN: 192 server tests and 115 client tests passed.
- Targeted Playwright: authentication setup plus the fused-plan scenario passed
  at `1440x1000` and `390x844`; the existing row remained present and only the
  company-holiday controls were disabled.
- Full client: 206 files, 3,458 tests passed and 38 tests skipped.
- Full server: 303 files and 5,444 tests passed. Two unrelated budget tests
  timed out while the server and client full suites competed on the 2-vCPU host;
  the complete budget file then passed alone (24/24 in 8.29 seconds).
- Shared: 34 files and 141 tests passed. Strict i18n file/key parity passed.
- Shared/server/client typechecks and the root production build passed.
- Changed-path lint had no errors. Existing warning debt remained outside this
  change; the new Playwright file passed ESLint with `--no-ignore`.

The production build retained pre-existing large-chunk and ineffective dynamic
import warnings. No schema or runtime configuration changed, so no database
migration or restore rehearsal was applicable.

## Rollback and Residual Risk

Rollback removes the guard and UI disablement only. Existing legacy rows are
never deleted or reassigned.

This guard stops further ambiguity but does not resolve existing fused rows,
per-user attribution, employer-period ownership, or plan-wide non-deduction
semantics. Those remain explicit Vacay v2 migration concerns.

The adversarial write-path inventory also found a separate destructive action:
`deleteYear` deletes the selected plan year's vacation entries, user-year rows,
and company-holiday rows together. It is reachable from the REST, MCP, and web
UI year-removal flows and is not a direct company-holiday toggle or setting
mutation. R0.1 therefore does not claim shared-year deletion safety. Before
deployment, the separate
[R0.2 year deletion safety](2026-07-30-vacay-year-deletion-safety.md) locally
implements fused-plan fail-closed deletion, actor-aware atomicity, negative
permissions, carry-chain repair, and responsive confirmation. It is not yet
pushed, merged, or deployed, and its invite-accept year reconciliation remains
a follow-up policy.

Local adversarial closeout for the stated R0.1 contract found no blocker. It
does not certify employment ownership or general fused-plan deletion safety.
