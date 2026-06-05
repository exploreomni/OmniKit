# Releases

This page summarizes OmniKit release notes for repository visitors and administrators deciding whether to clone or upgrade the app.

## v1.1.0 - Multi-Instance Ops Console

OmniKit v1.1.0 adds the full multi-instance operations console requested by early admin feedback.

### What Ships

- Native encrypted local vault at `./data/vault.enc` by default, overrideable with `OMNIKIT_VAULT_PATH`.
- Saved Omni instance profiles with source/destination roles, default model and folder settings, metric filters, and post-migration action templates.
- New **Instance Manager** page for vault lock/unlock/reset, saved instance CRUD, connection metrics, and embed-user metrics.
- One-time import path from the previous encrypted browser vault into the native vault.
- Model Migrator remains same-instance model remap by default, with a separate saved-instance dashboard copy/import mode.
- Saved-instance migration supports one source and one or more explicit migration targets, where each target chooses a destination instance, target model, and target folder. It supports same-destination multi-model fan-out, cross-instance fan-out, compatibility preflight, metadata preservation where supported, job history, and retry of failed import/export items.
- Multi-instance connection metrics now use schema-model coverage by connection ID instead of treating `defaultSchema` as the readiness signal.
- Post-migration actions are saved in the encrypted vault, explicitly enabled per job, HTTPS-only by default, and blocked from localhost/private-network targets unless `OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS=true`.
- Native vault idle auto-lock, job-history sensitive-data redaction, optional post-action hostname allowlisting, and focused security regression tests.

### Security And Privacy Posture

- Plaintext saved-instance API keys never return to the browser; UI responses show masked keys only.
- Decrypted vault contents and derived keys are held in server memory only while the vault is unlocked, and the vault auto-locks after idle time.
- `data/` is ignored by git so encrypted vault files and job history are not pushed.
- Non-secret job history uses `./data/jobs.json` by default, overrideable with `OMNIKIT_JOBS_PATH`, and redacts API keys, bearer tokens, card-like numbers, emails, and phone numbers before writing.
- Post-migration action history stores redacted action metadata only. Use `OMNIKIT_POST_ACTION_ALLOWLIST` to restrict allowed action hostnames.
- The browser encrypted vault remains only as a compatibility bridge for import into the native vault.

### Upgrade Guidance

For source-based installs:

```bash
git pull
npm install
npm run dev
```

After upgrading, open **Instance Manager**, create or unlock the native vault, and import any existing browser-vault target instances if needed.

## v1.0.0 - Initial Public Release

OmniKit v1.0.0 is the first public release of the local-first Omni admin workspace.

### What Ships

- A self-contained React, TypeScript, and Vite app that runs locally in the browser.
- Local API handlers mounted under `/api/*` for Omni admin workflows.
- A versioned in-app walkthrough for non-technical users, with first-run display, sidebar replay, update prompts, and Data Privacy reset controls.
- Dashboard AI & Delivery workflows:
  - AI Dashboard Studio with Build New Dashboard, Excel to Dashboard, and Review Existing Dashboard lanes.
  - Model Migrator with compatibility preflight for payload and target-field warnings.
  - Dashboard Operations
  - Dashboard Downloads
  - Deck Builder
- Data & AI Readiness workflows:
  - Connection Health
  - Upload Governance
  - Model & Topic Health
  - Content Health
  - AI Semantic Studio, including Semantic Migration Import for dbt, Looker, Power BI, Tableau, and Domo source artifacts.
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
- Raw Semantic Migration Import files, pasted source text, and Excel workbooks are held in page memory by default and are not written to browser storage unless the user explicitly exports or saves derived outputs through normal workflows.
- Generic proxy forwarding is restricted to approved Omni `/api/v1` paths.
- Other Omni API surfaces use dedicated local handlers.
- The app shell uses bundled assets and system fonts, with no external font CDN dependency.

### Validation

- `npm run typecheck` passed for the React app source.
- `npm run lint` passed with existing Fast Refresh warnings only.
- `npm run build` passed with non-blocking Vite bundle-size and JSZip chunk warnings.
- `npm audit --audit-level=moderate` reported 0 vulnerabilities.
- Release cleanup confirmed no tracked temporary workspace files, generated outputs, environment files, credentials, or local tool artifacts are included.

### Known Notes

- OmniKit is designed for a trusted local operator, not public internet hosting.
- The Vite dev server is for local use only.
- AI Dashboard Studio dashboard builds are first-pass drafts; final tile review, layout cleanup, save/share, and publishing remain in Omni.
- Excel to Dashboard does not mutate the semantic model directly. Formula-derived measures, lookup dimensions, and other semantic gaps are routed to AI Semantic Studio for reviewed YAML and dev-branch validation.
- Model Migrator compatibility preflight checks payload structure and target-field presence, but it cannot prove that same-named metrics have identical business definitions.
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
