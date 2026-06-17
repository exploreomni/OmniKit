# Dashboard Downloads Implementation Notes

Dashboard Downloads is a foreground browser workflow backed by saved Omni instances in the local native vault. The browser sends saved instance IDs to `/api/dashboard-downloads/*`; plaintext API keys stay server-side and are never stored in page state, request drafts, or recent-download history.

## Supported Formats

- Whole-dashboard exports support PDF, PNG, CSV, and XLSX.
- Single-tile exports support PDF, PNG, CSV, XLSX, and JSON.
- JSON requires single-tile mode and a tile with `queryIdentifierMapKey`.
- CSV exports may arrive as a ZIP containing one CSV per tile, matching Omni download behavior.

## Filters

Filters are scoped per dashboard. Batch downloads do not reuse the active dashboard's filter values for other dashboards; each queued dashboard loads its own details and builds its own `filterConfig`. If a selected dashboard cannot load details, that item is blocked instead of running with stale or wrong filters.

PNG exports include the same filter override request body as PDF exports, but Omni PNG rendering may ignore filter overrides in some download paths. The UI surfaces this caveat before queue execution.

## Row Limits

Row-limit override is opt-in. The request body sends `overrideRowLimit` and `maxRowLimit` only when the override is enabled and the row limit is a valid positive integer. Otherwise both fields are omitted. XLSX row-limit overrides require single-tile mode with a tile `queryIdentifierMapKey`; whole-dashboard XLSX row-limit overrides are blocked before the job starts.

## Queue And Recent Downloads

Whole-dashboard batch downloads run sequentially to avoid Omni download-job conflicts. A 409 response with an existing job ID attaches to the already-running job and continues polling it. Failed items do not stop later queued dashboards.

Recent downloads are session convenience state only. They store sanitized metadata, format/scope, filename, dashboard/tile labels, a concise filter summary, and the original sanitized request body so re-run uses the original request instead of current UI state. They do not store API keys or unredacted upstream errors.
