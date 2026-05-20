# Releases

This page summarizes OmniKit release notes for repository visitors and administrators deciding whether to clone or upgrade the app.

## v1.0.0 - Initial Public Release

OmniKit v1.0.0 is the first public release of the local-first Omni admin workspace.

### What Ships

- A self-contained React, TypeScript, and Vite app that runs locally in the browser.
- Local API handlers mounted under `/api/*` for Omni admin workflows.
- Dashboard AI & Delivery workflows:
  - AI Dashboard Studio
  - Model Migrator
  - Dashboard Operations
  - Dashboard Downloads
  - Deck Builder
- Data & AI Readiness workflows:
  - Connection Health
  - Upload Governance
  - Model & Topic Health
  - Content Health
  - AI Semantic Studio
- Governance workflows:
  - Labels
  - Schedules
  - User Management
  - Embed URLs
- Data Privacy controls for reviewing and clearing OmniKit browser storage.

### Security And Privacy Posture

- The local API binds to `127.0.0.1` only.
- No hosted OmniKit backend, database, analytics, or telemetry is required.
- Omni API keys are used only for requests to the Omni base URL entered by the operator.
- Active connection data is kept in React state and same-tab `sessionStorage`.
- Persistent app metadata uses browser `localStorage` and IndexedDB.
- The Data Privacy page clears OmniKit localStorage, IndexedDB, and sessionStorage entries.
- Generic proxy forwarding is restricted to approved Omni `/api/v1` paths.
- Other Omni API surfaces use dedicated local handlers.

### Validation

- `npm run typecheck` passed.
- `npm run lint` passed with existing Fast Refresh warnings only.
- `npm run build` passed with non-blocking Vite bundle-size and JSZip chunk warnings.
- `npm audit --audit-level=moderate` reported 0 vulnerabilities.
- Release cleanup confirmed no tracked temporary workspace files, generated outputs, environment files, credentials, or local tool artifacts are included.

### Known Notes

- OmniKit is designed for a trusted local operator, not public internet hosting.
- The Vite dev server is for local use only.
- Generated dashboard exports, deck files, copied diagnostics, and imported backups may contain customer data and should be handled according to your organization's data policy.
- The IndexedDB database name remains `omnikit-local` for browser data continuity from earlier builds.

### Upgrade Guidance

For source-based installs:

```bash
git pull
npm install
npm run dev
```

If the app behaves unexpectedly after an upgrade, open the Data Privacy page and clear OmniKit local data, then reconnect to Omni.
