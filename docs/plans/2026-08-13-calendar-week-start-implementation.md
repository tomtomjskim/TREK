# Calendar Week Start Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a per-user Sunday/Monday calendar preference that consistently drives shared date pickers, Journey, and Vacay while preserving legacy Vacay plan values only as a fallback.

**Architecture:** Extend the existing typed per-user key/value settings contract with `calendar_week_start: 0 | 1`; no schema migration or dependency is required. A small pure calendar helper owns weekday ordering and month offsets, shared and Journey pickers read the effective user preference, and Vacay resolves explicit user preference before its legacy plan value. The old Vacay plan editor is removed so two writable controls cannot conflict.

**Tech Stack:** React 19, Zustand, TypeScript, Vitest/Testing Library, existing TREK i18n and settings API.

---

## Readiness and scope

- Lane: `upstream-contrib` candidate, implemented and validated fork-first only.
- Data owner: authenticated per-user `settings` key/value row; no DB migration.
- Design intent: one discoverable control beside Time Format under Language & region, using the existing two-button visual pattern.
- Target workflow: a user chooses Sunday or Monday once and every affected date picker updates immediately.
- Existing UI benchmark: `DisplaySettingsTab` Time Format control and `CustomTimePicker` settings-store consumption.
- State matrix: unset/default Monday, explicit Monday, explicit Sunday, save failure, Vacay legacy fallback, mobile and desktop.
- Non-goals: locale auto-detection, new date library, calendar rewrite, admin default setting, TransportModal redesign, official PR or deployment.
- Evidence: focused Vitest, client typecheck/lint/format/i18n/build, 390px and 1440px Playwright screenshots plus console check.

### Task 1: Shared preference contract and helper

**Files:**
- Create: `client/src/utils/calendarWeek.ts`
- Create: `client/src/utils/calendarWeek.test.ts`
- Modify: `client/src/types.ts`
- Modify: `client/src/store/settingsStore.ts`
- Modify: `client/tests/helpers/factories.ts`

**Step 1: Write failing tests**

Add pure helper tests that assert:

- unset and `1` produce Monday-first weekday indices and offsets;
- `0` produces Sunday-first indices and makes `2026-03-01` offset zero;
- invalid persisted input normalizes to Monday.

**Step 2: Verify RED**

Run:

```bash
npm run test --workspace=client -- --run src/utils/calendarWeek.test.ts
```

Expected: FAIL because the helper and setting type do not exist.

**Step 3: Implement minimally**

- Export `CalendarWeekStart = 0 | 1` from `client/src/types.ts`.
- Add optional `calendar_week_start?: CalendarWeekStart` to `Settings`.
- Add Monday (`1`) to `DEFAULT_SETTINGS` and `buildSettings`.
- Implement pure helpers for normalizing the setting, ordering JS weekday indices, and computing a month-start offset.

**Step 4: Verify GREEN**

Run the focused helper test and client typecheck.

### Task 2: Global Settings UI and translations

**Files:**
- Modify: `client/src/components/Settings/DisplaySettingsTab.tsx`
- Modify: `client/src/components/Settings/DisplaySettingsTab.test.tsx`
- Modify: `shared/src/i18n/*/settings.ts`

**Step 1: Write failing tests**

Assert that the control renders in Language & region, defaults to Monday, calls
`updateSetting('calendar_week_start', 0)` for Sunday, reflects the optimistic store value,
and displays a toast when persistence rejects.

**Step 2: Verify RED**

Run only `DisplaySettingsTab.test.tsx`; expect missing control assertions to fail.

**Step 3: Implement minimally**

Add the existing two-button option pattern after Time Format. Add parity-safe setting keys
for label, hint, Monday and Sunday in all locale settings modules; English fallback text is
acceptable for locales without a reviewed translation, while Korean and English receive
native copy.

**Step 4: Verify GREEN**

Run the component test and strict i18n parity.

### Task 3: Shared and Journey date pickers

**Files:**
- Modify: `client/src/components/shared/CustomDateTimePicker.tsx`
- Modify: `client/src/components/shared/CustomDateTimePicker.test.tsx`
- Modify: `client/src/components/Journey/JourneyDetailPageDatePicker.tsx`
- Create: `client/src/components/Journey/JourneyDetailPageDatePicker.test.tsx`

**Step 1: Write failing tests**

- Shared picker: Sunday setting renders Sun–Sat and `2026-03-01` in column one; default remains Monday-first.
- Journey picker: the same setting changes header order and first-day offset without changing selection behavior.

**Step 2: Verify RED**

Run both test files; expect Sunday-order assertions to fail against hardcoded Monday behavior.

**Step 3: Implement minimally**

Read `calendar_week_start` from `useSettingsStore` and use the shared pure helper. Generate
localized weekday labels in shared picker and reorder the existing Journey abbreviations; do
not change date serialization, portal, navigation, or selection contracts.

**Step 4: Verify GREEN**

Run both component suites and the adjacent Journey page date-picker tests.

### Task 4: Vacay precedence and single writable control

**Files:**
- Modify: `client/src/components/Vacay/VacayCalendar.tsx`
- Modify: `client/src/components/Vacay/VacayCalendar.test.tsx`
- Modify: `client/src/components/Vacay/VacaySettings.tsx`
- Modify: `client/src/components/Vacay/VacaySettings.test.tsx`

**Step 1: Write failing tests**

- Explicit user Sunday overrides legacy plan Monday.
- Explicit user Monday overrides legacy plan Sunday.
- If no explicit user value exists, legacy plan value remains effective.
- Vacay settings no longer renders or mutates the plan-level week-start control.

**Step 2: Verify RED**

Run the two Vacay suites; expect precedence and removed-control assertions to fail.

**Step 3: Implement minimally**

Read the raw optional setting in `VacayCalendar`, then resolve
`settings.calendar_week_start ?? plan.week_start ?? 1`. Remove only the obsolete editable
week-start block and its unused icon import from `VacaySettings`; retain the database field and
server API for backward compatibility.

**Step 4: Verify GREEN**

Run Vacay calendar/settings/month-card suites.

### Task 5: Documentation and verification pipeline

**Files:**
- Modify: `docs/plans/2026-08-03-calendar-week-start-scope-diagnostic.md`
- Modify: `docs/project-source-map.md`
- Modify: `docs/README.md`

**Step 1: Update evidence**

Record the implemented contract, changed owning paths, tests, rollback-by-revert, and the fact
that no schema migration, official PR, push, deployment, or production data change occurred.

**Step 2: Run compact code gates**

```bash
npm run test --workspace=client -- --run <changed focused suites>
npm run typecheck --workspace=client
npm run lint:check --workspace=client
npm run format:check --workspace=client
npm run i18n:parity:strict --workspace=shared
npm run build --workspace=client
git diff --check
```

**Step 3: Run browser acceptance**

At 390px and 1440px, verify the Display control, immediate picker header/order update,
keyboard focus, no horizontal overflow, and clean browser console. Capture non-sensitive
screenshots or a Playwright report tied to this branch.

**Step 4: Run bounded review pipeline**

Request independent correctness, UX/accessibility, and adversarial review. Normalize findings,
fix blockers/major issues with RED→GREEN tests, and run one final fresh evidence pass.

**Step 5: Commit locally**

Use conventional commits. Do not push, merge to `main`, deploy, or publish upstream without a
separate TOM instruction.
