# Place Enrichment and Google Cost Guard Design

## Objective

Let trip editors safely refresh imported Google/Naver places that currently have only a name and coordinates, while preventing TREK-originated Google Places calls from crossing conservative monthly free-use budgets.

## Product contract

- TREK remains the source of truth. Refresh never overwrites notes, category, schedule, reservation data, user-entered values, or existing provider links.
- Refresh is explicit and two-step: scan/preview, then apply selected matches.
- Scan defaults to unlinked places with valid coordinates and returns up to three nearby candidates per place.
- Only high-confidence matches are preselected. Other nearby candidates require an explicit user choice.
- Apply fills only empty `google_place_id`, `google_ftid`, `address`, `website`, and `phone` fields.
- V1 does not auto-delete places, run on a schedule, change categories, or fetch photos during refresh.
- Existing import enrichment remains available, but every paid Google request is covered by the same guard.

## API contract

### `POST /api/trips/:tripId/places/enrichment/preview`

Request:

```json
{ "place_ids": [1, 2], "lang": "ko" }
```

`place_ids` is optional. When omitted, the server scans unlinked places with coordinates, up to 100 per request. The caller must have trip access and `place_edit`.

Response includes candidates, per-place errors/skips, and current Google SKU usage. A candidate contains the Google place ID, display name, address, coordinates, types, distance, and `safe`/`review` confidence. Preview uses only the Text Search Pro field mask.

### `POST /api/trips/:tripId/places/enrichment/apply`

Request:

```json
{
  "matches": [
    { "place_id": 1, "google_place_id": "ChIJ..." }
  ],
  "lang": "ko"
}
```

The server reloads each trip place, fetches fresh Place Details (explicit apply bypasses the ordinary seven-day read cache), rejects provider coordinates more than 250 metres from the stored point, and fills only empty provider/contact fields. Apply is capped at 100 matches. Updated places are broadcast over the existing websocket event.

Both batch endpoints preserve successful partial results if a later provider call fails or reaches the cap. If no call can start because the cap is already exhausted, the endpoint returns HTTP 429 with a stable error code.

## Billing guard

Every Google Places request reserves one attempt in SQLite before network I/O. Reservations are atomic and are never refunded after provider or network failures. This intentionally undercounts remaining allowance rather than risking an overrun.

The ledger key is the Google billing month in `America/Los_Angeles`, matching Google's monthly reset policy. Defaults are fixed at 80% of the documented free-use caps:

| Internal SKU | Google free cap | TREK hard cap |
| --- | ---: | ---: |
| Autocomplete Requests | 10,000 | 8,000 |
| Text Search Pro | 5,000 | 4,000 |
| Text Search Enterprise | 1,000 | 800 |
| Place Details Enterprise | 1,000 | 800 |
| Place Details Enterprise + Atmosphere | 1,000 | 800 |
| Place Details Photos | 1,000 | 800 |

IDs-only validation calls are tracked with a separate operational ceiling even though the documented monthly free cap is unlimited. Environment overrides may only lower a cap, including setting it to zero; they cannot raise the built-in ceiling.

The guard protects only calls made by this TREK instance. It cannot account for another application using the same Google project/key, reporting delay, future Google price changes, or manual calls outside TREK. Production therefore also requires a dedicated restricted key/project, Google per-method quotas where available, and Cloud Billing budget alerts. Budget alerts are notifications, not hard spending caps.

Official references (checked 2026-07-15):

- https://developers.google.com/maps/billing-and-pricing/overview
- https://developers.google.com/maps/billing-and-pricing/pricing
- https://developers.google.com/maps/documentation/places/web-service/data-fields
- https://docs.cloud.google.com/billing/docs/how-to/budgets

## Data model

An additive migration creates:

```sql
CREATE TABLE google_api_usage (
  period TEXT NOT NULL,
  sku TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (period, sku)
);
```

No provider payload or API key is stored in this table. Old periods are retained for a small audit trail and can be pruned later under an explicit retention policy.

## UI

The existing Places sidebar gets one `Refresh details` action beside import actions when the user can edit places and a Maps key is available. It opens a focused modal using existing TREK surfaces and controls.

States: introduction/cost estimate, scanning, results, no eligible places, no matches, partial provider failure, hard-cap reached, applying, and completed. Partial failures show counts without exposing raw provider diagnostics. The result list shows the original place, selected candidate, distance, confidence, and a checkbox. It traps focus while open, has labelled controls and live status text, and remains usable at 390px and 1440px widths.

## Failure, rollback, and evidence

- Provider, validation, and quota failures do not mutate a place during preview.
- Apply updates one place atomically; earlier successful rows remain visible if a later row fails.
- Code rollback restores the previous image. The additive usage table is harmless if retained.
- Production deployment requires a fresh SQLite backup, migration rerun evidence, targeted unit/integration/UI tests, full builds, mobile/desktop screenshots, health checks, and an authenticated negative-permission test.
