# Trip Planner Adaptive Map Controls Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make trip-planner map and panel controls collision-free and touch-accessible on unfolded Fold and constrained desktop viewports.

**Architecture:** Add a pure corridor-layout model and a small responsive hook, then use the model to select wide, compact, or stacked map controls. Extend the existing POI pill with an accessible compact popover and increase the existing panel toggle targets without changing mobile drawers or backend contracts.

**Tech Stack:** React 19, TypeScript, Tailwind/CSS variables, Vitest, Testing Library, Playwright

---

### Task 1: Specify Corridor Layout With RED Tests

**Files:**

- Create: `client/src/components/Map/mapControlLayout.test.ts`
- Create: `client/src/components/Map/mapControlLayout.ts`

**Steps:**

1. Write table-driven tests for 768, 800, 884, 1024, and 1280px with default,
   collapsed, and 520px panels.
2. Assert mode, centre coordinate, and non-intersection safety boundaries.
3. Run the focused test and confirm RED because the model does not exist.
4. Implement the smallest pure model that returns `wide`, `compact`, or
   `stacked` and re-run until GREEN.

### Task 2: Specify Compact POI Interaction With RED Tests

**Files:**

- Create: `client/src/components/Map/PoiCategoryPill.test.tsx`
- Modify: `client/src/components/Map/PoiCategoryPill.tsx`

**Steps:**

1. Write failing tests for the 44px compact trigger, translated accessible
   state, two-column labelled choices, category toggle, retry/search action,
   Escape, and outside click.
2. Run the focused component test and confirm the intended failures.
3. Implement the compact trigger and portal popover with existing translations,
   icons, colours, and frosted tokens.
4. Re-run the component test until GREEN and keep the wide rendering unchanged.

### Task 3: Integrate Adaptive Controls And Accessible Panel Toggles

**Files:**

- Create: `client/src/components/Map/AdaptiveMapControls.tsx`
- Create: `client/src/components/Map/AdaptiveMapControls.test.tsx`
- Modify: `client/src/pages/TripPlannerPage.tsx`

**Steps:**

1. Write failing integration-level component tests for resize-driven mode
   changes and control positioning.
2. Implement the viewport listener and render POI/compass using the pure layout
   result.
3. Replace the fixed desktop cluster in `TripPlannerPage` and pass live sidebar
   width/collapse state.
4. Increase both desktop panel toggle targets to 44px, add translated
   `aria-label` and `title`, and keep their layer above map controls.
5. Run the new tests plus `TripPlannerPage.test.tsx` until GREEN.

### Task 4: Verify Fold Geometry And Regression Surface

**Files:**

- Modify only if required by a verified failure in the files above.

**Steps:**

1. Run client typecheck and lint the changed frontend files.
2. Run focused tests, then the client test suite and production build.
3. Run Playwright at 768, 800, 884, 1024, and 1280px with minimum/default/
   maximum panel widths; assert panel-toggle and map-control rectangles do not
   intersect.
4. Check keyboard Escape, touch-sized targets, browser console errors, and
   capture screenshots only for failures or final visual evidence.
5. Run `git diff --check`, review the changed-path diff, and record residual
   real-device risk without deploying or pushing.
