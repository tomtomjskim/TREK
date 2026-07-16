# Trip Planner Adaptive Map Controls Design

## Goal

Keep the trip planner's panel controls usable on an unfolded Galaxy Fold and
other constrained desktop-width layouts while preserving the current
side-by-side planning workflow.

## Root Cause

The desktop POI and compass cluster is fixed to the viewport centre from the
`md` breakpoint onward. The left and right sidebars have independently
persisted widths, and their close toggles protrude into the map. The cluster is
therefore allowed to occupy the same coordinates as both panel toggles. Its
higher stacking level wins pointer input, making the plan difficult to use.

## Considered Approaches

1. Make every viewport below 1024px use the mobile drawer layout. This is
   simple and touch-friendly, but removes the useful simultaneous plan, map,
   and places view on an unfolded Fold.
2. Move the existing full-width cluster down at a fixed breakpoint. This is a
   small patch, but persisted 200–520px sidebar widths can recreate the
   collision on other viewport sizes.
3. Position controls inside the live corridor between the side panels and
   adapt their density to that corridor. Selected: it is device-independent,
   retains the current planner workflow, and handles panel resizing as well as
   viewport resizing.

## Interaction Contract

- `wide`: render the existing eight-category pill and compass in one row,
  centred inside the free map corridor.
- `compact`: replace the category row with one 44px nearby-search trigger and
  keep the compass beside it. The trigger opens a labelled two-column category
  popover.
- `stacked`: when even the compact row does not fit, stack the two 44px controls
  below the panel toggles. Panel controls retain pointer priority.
- The compact popover exposes active, loading, error, and moved-map states. Its
  search-area retry action stays inside the popover.
- The popover closes on outside pointer input or Escape, and advertises its
  expanded state and dialog relationship to assistive technology.
- Existing mobile behaviour below 768px remains unchanged.
- Panel collapse toggles become 44px targets with translated accessible names.

## Geometry Contract

The layout model receives viewport width, current panel widths, collapse state,
and which map controls exist. It reserves the panel margin, visible panel,
toggle overhang, and a 12px safety gap on each side. Full controls are selected
only when their measured contract width fits; otherwise the model selects the
compact row or stacked fallback. The model is a pure function so Fold and
resized-panel cases can be verified without browser-layout timing.

## Visual Direction And Assets

The change keeps TREK's restrained, utilitarian frosted-map aesthetic:
`--sidebar-bg`, existing shadows, category colours, Lucide icons, and the
project typography. No new asset, font, production dependency, or global design
token is introduced.

## State Matrix

- Viewport: mobile `<768`, constrained desktop `768–1099`, wide desktop.
- Panels: both open, one collapsed, both collapsed, persisted minimum/default/
  maximum widths.
- POI: disabled, no active category, one or more active, loading, request error,
  map moved since search.
- Map provider: Leaflet without compass, GL with compass.
- Interaction: pointer, coarse touch, keyboard focus, Escape, outside click.

## Evidence And Rollback

- RED/GREEN unit tests for 768, 800, 884, 1024, and 1280px geometry and panel
  widths from 200 to 520px.
- Component tests for the compact trigger, category selection, status action,
  outside click, Escape, and accessible panel controls.
- Client typecheck, lint on changed files, focused/full relevant tests, build,
  and Playwright bounding-box checks at target viewports.
- Reverting the frontend commit fully rolls back the change; there is no API,
  database, storage, or production configuration change.
