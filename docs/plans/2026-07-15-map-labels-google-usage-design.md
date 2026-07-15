# Map Labels and Google Usage Administration Design

## Objective

Make the tokenless OpenFreeMap map readable in Korean (or another selected language), and give TREK administrators a clear view of TREK-local Google Places usage plus an immediate switch that stops bulk place enrichment.

## Product contract

- Map label language is a user preference with four choices: follow the TREK interface language, local/native labels, Korean, or English.
- The default is to follow the interface language. Existing users therefore get Korean labels when their TREK language is Korean without having to discover a hidden query parameter.
- OpenFreeMap/MapLibre changes only name-bearing symbol layers. Road numbers, shields, transit references, and other non-name labels keep the provider style expression.
- Leaflet's raster tiles cannot be relabelled client-side. The settings UI states this and preserves the preference for use when a GL provider is selected.
- Mapbox Standard continues to use its supported basemap language setting. OpenFreeMap remains the no-token default GL option.
- The administrator usage view reports only calls recorded by this TREK instance. It never claims to be the Google billing source of truth.
- The existing per-SKU conservative monthly caps remain enforced. Administrators can refresh the snapshot and disable or enable bulk place enrichment; they cannot reset or edit counters.
- Disabling enrichment is enforced by both preview and apply endpoints, not only by hiding the client action. Normal map display, autocomplete, and ordinary place lookup remain governed by their existing separate controls and caps.

## Options considered

### Map labels

1. Add a language query parameter to raster/OpenFreeMap URLs. Rejected: the tested provider style and raster endpoints do not expose a reliable runtime locale parameter, and raster labels are already rendered into pixels.
2. Rewrite name-bearing MapLibre symbol-layer expressions at runtime. Chosen: it is tokenless, works with the existing OpenFreeMap styles, and can preserve each layer's original fallback expression.
3. Require Mapbox Standard for localized labels. Rejected: it adds a vendor token/cost dependency when the current requirement can be met with OpenFreeMap.

### Usage administration

1. Show usage only in enrichment modal responses. Rejected: administrators need a discoverable aggregate status before a trip action starts.
2. Add a read-only admin snapshot plus a dedicated enrichment kill switch. Chosen: it uses the existing local ledger and app-settings pattern without a migration or new external credentials.
3. Integrate Google Cloud Billing and quota APIs. Rejected for this increment: it requires project-level IAM and cross-service billing aggregation, and still would not provide a true hard spending cap.

## Map implementation

`map_label_language` is stored alongside existing user settings as `auto`, `local`, `ko`, or `en`. `auto` resolves from the active TREK locale, with provider-compatible aliases where needed.

For MapLibre, a small pure helper inspects symbol layers after the style loads. A layer is eligible only when its original `text-field` expression contains a name property. The localized expression is:

```text
coalesce(name:<locale>, name_<locale>, original provider expression)
```

The helper stores the unmodified provider expression per map instance and layer. Switching languages always rebuilds from that original expression; selecting `local` restores it. Style reloads are handled by reapplying after `styledata`/load readiness. This prevents nested expressions and preserves provider fallbacks.

For Mapbox Standard, `auto`, `ko`, and `en` resolve through the existing basemap language config. Selecting `local` leaves the newly constructed map at the provider default.

## API and authorization contract

### `GET /api/admin/google-api-usage`

Returns the current local ledger snapshot for all guarded SKUs, including period, billing timezone, attempts, configured cap, remaining attempts, documented free-use reference cap, and exhaustion state. The existing controller-level JWT and admin guards apply.

### `GET /api/admin/places-enrichment`

Returns `{ "enabled": boolean }`. A missing setting defaults to `true`, matching current behavior.

### `PUT /api/admin/places-enrichment`

Accepts `{ "enabled": boolean }`, persists the app setting, and records the existing admin audit event pattern.

When disabled, both trip enrichment endpoints return HTTP 403 with stable code `PLACE_ENRICHMENT_DISABLED`. The public app-config response exposes only the boolean so the client can hide the action; it exposes no key or usage data.

## UI states and accessibility

Map settings use the existing labelled select/card pattern and explain provider support. The admin usage panel uses responsive cards instead of a wide table, with loading, error/retry, empty-safe, and loaded states. Each SKU shows used/cap/remaining values and a progress element with accessible text. Exhausted rows have text/icon treatment in addition to color.

The enrichment switch sits with the existing Google feature controls and includes explicit scope copy. Existing TREK spacing, typography, focus treatment, dark mode, and mobile stacking are preserved.

## Failure, cost, and rollback

- A style layer that cannot be rewritten is left untouched; one malformed provider layer does not break the map.
- Admin usage-fetch failure does not affect other settings and can be retried.
- The switch defaults enabled only when absent, preserving upgrade behavior. Server enforcement prevents stale clients from bypassing it.
- The usage snapshot is conservative and TREK-local: failed outbound attempts remain counted, calls from other apps/keys are invisible, and Google reporting/pricing can change.
- No database schema migration is required. Rollback is code-only; retained app-setting keys are harmless to the prior version.
- Production evidence includes focused tests, full builds/suites, admin authorization checks, desktop/mobile screenshots, health checks, and a recorded previous image rollback target.
