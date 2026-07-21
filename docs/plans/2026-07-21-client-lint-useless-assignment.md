# Client Useless Assignment Lint Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the four existing `no-useless-assignment` violations without changing
currency formatting or tooltip placement, then make new violations fail client CI.

**Architecture:** Keep the existing `CostsPanel` formatting and `Tooltip` positioning
control flow intact. Characterize both `Intl.formatToParts` fallbacks and every typed
tooltip placement, remove only initial values that are overwritten before any read, and
promote the existing ESLint warning to a zero-debt error gate.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, ESLint flat config

---

## Design and scope

### Root cause

ESLint reports four writes that cannot reach a read:

- `CostsPanel.bigMoney` initializes `parts` to `null`, then either overwrites it or
  returns from `catch`.
- `SummaryCard` initializes `parts` to `null`, then assigns an array in `try` or
  assigns `null` in `catch`.
- `Tooltip` initializes `top` and `left` to zero, then every `Placement` branch assigns
  both values before viewport clamping reads them.

These are redundant initializations, not evidence that the current runtime result is
wrong. They obscure the definite-assignment contract and keep a low-volume correctness
rule from becoming a CI gate.

### Behavior contract

1. Desktop `SummaryCard` and mobile `bigMoney` keep locale/currency output when
   `Intl.NumberFormat.formatToParts` succeeds.
2. Both formatting paths keep using `formatMoney` if `formatToParts` throws.
3. Tooltip placements retain these unclamped coordinates for trigger rect
   `{ top: 100, left: 100, right: 140, bottom: 120, width: 40, height: 20 }`, tooltip
   `20×10`, and gap `6`: top `(84, 110)`, bottom `(126, 110)`, left `(105, 74)`, right
   `(105, 146)`.
4. Existing viewport clamping, portal lifecycle, delay, child handlers, currency
   conversion, API and state flow are unchanged.
5. `no-useless-assignment` applies as `error` to both client `src` and `tests`; unrelated
   warning severities remain unchanged.

### Alternatives considered

- **Remove only redundant initializers (selected):** smallest upstream-compatible diff;
  TypeScript control flow proves every continuing path assigns before read.
- **Extract currency and geometry helpers:** improves direct unit-test seams but expands
  the refactor without a behavior requirement.
- **Disable the rule at each line:** preserves redundant code and hides future debt.

### Change lane and retirement

This is temporary `fork-core maintenance`. It changes no API, database, dependency,
layout, deployment or instance configuration. Remove the local syntax patch when a
verified official release preserves the two currency-format fallback paths and four
tooltip placements while carrying zero `no-useless-assignment` violations. Do not push
or open a PR against `liketrek/TREK`, and do not deploy production in this batch.

## Task 1: Characterize the formatting and placement contracts

**Files:**

- Modify: `client/src/components/Budget/CostsPanel.test.tsx`
- Create: `client/src/components/shared/Tooltip.test.tsx`

**Step 1: Add a controllable mobile-layout seam in the existing Costs test**

Use a hoisted `useIsMobile` mock whose value resets to `false` in `beforeEach`. Do not
change the production hook.

**Step 2: Characterize both currency fallback paths**

Add desktop and mobile cases that make
`Intl.NumberFormat.prototype.formatToParts` throw, render a EUR 90 expense, and assert
that the `Total trip spend` container still contains the exact
`formatMoney(90, 'EUR', 'en')` fallback. Restore the spy in a `finally` block.

**Step 3: Characterize every tooltip placement**

Add a table-driven component test using a fixed trigger rect and tooltip dimensions.
Open the tooltip with `delay={0}` and assert the visible `top`/`left` values for `top`,
`bottom`, `left` and `right` against the behavior contract.

**Step 4: Verify the characterization baseline**

Run:

```bash
npm run test --workspace=client -- \
  src/components/Budget/CostsPanel.test.tsx \
  src/components/shared/Tooltip.test.tsx
```

Expected: 2 files and 25 tests pass before production changes.

**Step 5: Commit**

```bash
git add client/src/components/Budget/CostsPanel.test.tsx \
  client/src/components/shared/Tooltip.test.tsx
git commit -m "test: characterize client assignment paths"
```

## Task 2: Create the static RED and remove only redundant writes

**Files:**

- Modify: `client/eslint.config.mjs`
- Modify: `client/src/components/Budget/CostsPanel.tsx`
- Modify: `client/src/components/shared/Tooltip.tsx`

**Step 1: Promote the rule before production edits**

Move `no-useless-assignment` from the warning-debt block to the zero-debt guardrails.

**Step 2: Verify RED**

Run:

```bash
cd client
npx eslint src/components/Budget/CostsPanel.tsx \
  src/components/shared/Tooltip.tsx
```

Expected: exit non-zero with exactly four `no-useless-assignment` errors and nine
unrelated warnings.

**Step 3: Remove the two `parts` initializers**

Declare `bigMoney`'s `parts` as `Intl.NumberFormatPart[]` without an initial value. Its
`catch` continues returning the existing fallback. Declare `SummaryCard`'s `parts` as
`Intl.NumberFormatPart[] | null` without an initial value; its `catch` continues assigning
`null`.

**Step 4: Remove the `top` and `left` initializers**

Declare both as numbers without initial values. Preserve every placement branch and the
two clamp assignments byte-for-byte.

**Step 5: Verify GREEN**

Run the 25 focused tests and the target lint command again.

Expected: 25/25 tests pass; target lint exits zero with nine unrelated warnings and zero
`no-useless-assignment` messages.

**Step 6: Commit**

```bash
git add client/eslint.config.mjs \
  client/src/components/Budget/CostsPanel.tsx \
  client/src/components/shared/Tooltip.tsx
git commit -m "refactor: remove redundant client assignments"
```

## Task 3: Document, verify and integrate only in the fork

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/upstream/README.md`

**Step 1: Record the maintenance batch**

Link this plan from the maintainer index. Add a patch-inventory row with the selected
lane, formatting/placement contract and objective retirement signal. The source map does
not change because no entry point, ownership or runtime boundary moves.

**Step 2: Run full local validation**

```bash
npm run typecheck --workspaces --if-present
npm test
npm run lint --workspace=client
npm run build
git diff --check
```

Expected: all commands pass. Full client lint becomes 0 errors / 1,265 warnings, down
exactly four from the 1,269-warning baseline, and the promoted rule has zero violations.
Existing build advisories remain separate debt.

**Step 3: Review and publish only to the fork**

Request an independent read-only review. If no material finding remains, push
`fix/client-no-useless-assignment`, open a draft PR against `tomtomjskim/TREK:main`, wait
for all required CI, mark ready and squash-merge only while the PR is clean and mergeable.
Do not touch the official upstream repository or production deployment.

**Step 4: Synchronize generated knowledge and clean up**

Fast-forward the local fork `main`, verify the squash tree equals the reviewed branch
tree, remove the temporary branch/worktree, and record the evidence in
`personal-wiki/wiki/generated/llm/codebase/trek/client-test-warning-gates.md`. Regenerate
and validate wiki graph/meta artifacts before pushing the wiki commit.

## Final local evidence

- Baseline: `CostsPanel.test.tsx` passed 19/19 and target lint reproduced exactly four
  `no-useless-assignment` warnings across the two production files.
- Characterization: desktop/mobile currency fallback and four tooltip placements passed
  as 25/25 tests before production edits; the two test files linted with zero messages.
- Static RED: promoting the rule to `error` produced exactly four target errors and nine
  unrelated warnings at the known `parts`, `top` and `left` initializers.
- GREEN: removing only those initial values restored target lint to 0 errors / nine
  unrelated warnings, kept the 25 focused tests green and passed client typecheck.
- Full client lint checked 657 files with 0 errors / 1,265 warnings, down exactly four
  from the 1,269-warning baseline; `no-useless-assignment` has zero violations and
  src/test `--print-config` reports severity 2.
- Workspace typecheck passed for client, server and shared.
- Full tests passed: shared 34 files / 141 tests, server 304 files / 5,430 tests, client
  206 files / 3,441 passed and 38 skipped.
- Production build passed; the client bundle completed in 7.30s. Existing plugin timing,
  ineffective dynamic-import and large-chunk advisories remain separate build debt.
- `git diff --check` passed. No API, database, dependency, image, Compose, layout,
  official upstream repository or production deployment was changed.
