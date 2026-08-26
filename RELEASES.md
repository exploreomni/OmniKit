# Releases

This page summarizes OmniKit release notes for repository visitors and administrators deciding whether to clone or upgrade the app.

## Unreleased - Dashboard Migration Polish

- Retired **BI Migration Studio** and its source connectors, provider integrations, local migration engine, release machinery, and dedicated test fixtures. Existing `/semantic-migrations` bookmarks now show a no-API retirement notice, and Data Privacy provides an explicit cleanup path for encrypted legacy credentials.

- Replaced the dependency-first **Dashboard Migrator** with a three-screen safe-copy flow: choose dashboards, choose one or more destinations, then move and track. All selected dashboards route to every selected destination without exposing dependency mapping, YAML, cleanup, waiver, delete, or replacement controls.
- Moved compatible semantic resolution and validation behind the workflow. Ambiguous, incompatible, protected, stale, or unsafe destinations stop independently while other destinations continue.
- Added durable request identity, lost-response and restart recovery, exact target-only retry, uncertain-import reconciliation, suffix-only collision handling, content/access/query verification, and fail-closed vault-session cancellation.
- Source dashboards remain in place, destination folders are never emptied, direct source sharing is not copied, and unrelated same-name dashboards are never updated or moved to Trash.
- Retained legacy Dashboard Migrator job reading and recovery for compatibility. Its dependency editor and destructive controls are available only through an internal rollback switch, not the normal product experience.
- Kept **Model Migrator** as the semantic-layer branch workflow for moving Omni model YAML, workbook query content, and related dashboard handoff items between saved instances.
- Updated Home's workspace snapshot so the **Models** tile counts active semantic-layer models instead of broad model catalog, schema, or branch rows.
- Added the migration planner regression suite to the security workflow and local `security:check` gate.
- Added workspace snapshot regression tests to the security workflow and local `security:check` gate.

## v1.1.0 - Multi-Instance Ops Console

OmniKit v1.1.0 adds the full multi-instance operations console requested by early admin feedback.

### What Ships

- Native encrypted local vault at `./data/vault.enc` by default, overrideable with `OMNIKIT_VAULT_PATH`.
- Saved Omni instance profiles with source/destination roles, default model and folder settings, metric filters, and post-migration action templates.
- New **Instance Manager** page for vault lock/unlock/reset, saved instance CRUD, structured metric filters, structured post-migration webhooks, connection metrics, schema refresh actions, and embed-user activity metrics.
- Home is now the vault-first starting point: users create or unlock the native vault there, choose a saved instance there, and use the sidebar only for active-instance status and switching.
- Legacy `omni-multi-instance-tools` vault import with dry-run review, duplicate base-URL detection, invalid profile skipping, unsafe post-action dropping, and native-vault re-encryption.
- Dashboard Migrator uses a saved-instance copy/import workflow with source connection selection, connection-scoped dashboard loading, visible folder/model/topic metadata, dashboard grouping, multi-target destination rows, route assignment, route-map review, and live run progress.
- Destination rows can repeat the same target instance when different connections, models, folders, or topic handling are needed.
- Dashboard migration supports exact-match topic mapping, new topic creation, destination `baseModelId` import, same-name replacement scoped to the selected target folder, metadata preservation where supported, job history, cancel, and retry of failed destinations without rerunning successful work.
- Multi-instance connection metrics now use schema-model coverage by connection ID instead of treating `defaultSchema` as the readiness signal.
- Embed-user metrics include active 7/30/90-day counts, never-logged-in counts, weekly login trends, monthly signup trends, and entity rollups.
- Schema refresh can be queued from connection rows or as a built-in post-import destination option, using vault credentials server-side instead of user-authored webhook URLs.
- Post-migration actions are saved in the encrypted vault, explicitly enabled per job, HTTPS-only by default, and blocked from localhost/private-network targets unless `OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS=true`.
- Unified History combines browser operation logs with redacted local migration job history, including retry lineage and read-only job detail.
- Native vault idle auto-lock, job-history sensitive-data redaction, optional post-action hostname allowlisting, and focused security regression tests.

### Security And Privacy Posture

- Plaintext saved-instance API keys never return to the browser; UI responses show masked keys only.
- Decrypted vault contents and derived keys are held in server memory only while the vault is unlocked, and the vault auto-locks after idle time.
- `data/` is ignored by git so encrypted vault files and job history are not pushed.
- Non-secret job history uses `./data/omnikit-jobs.json` by default, overrideable with `OMNIKIT_JOB_HISTORY_PATH`, and redacts API keys, bearer tokens, card-like numbers, emails, and phone numbers before writing. Older `jobs.json` files can be imported once through `OMNIKIT_JOBS_PATH` when the history file is empty.
- Post-migration action history stores redacted action metadata only. Use `OMNIKIT_POST_ACTION_ALLOWLIST` to restrict allowed action hostnames.
- The deprecated browser encrypted vault is not used for new migration credentials. Re-add needed profiles to the native vault and clear the legacy browser cache from Instance Manager or Data Privacy.
- Compatible legacy multi-instance vault imports never return plaintext imported API keys to the browser. Legacy job history from the old repo is not imported in this release; keep the old SQLite database as a read-only archive if you need historical audit evidence.

### Upgrade Guidance

For source-based installs:

```bash
git pull
npm install
npm run dev
```

After upgrading, open **Instance Manager**, create or unlock the native vault, and add the source and destination Omni profiles you want to reuse in dashboard migrations. If you are moving from `omni-multi-instance-tools`, run the legacy vault dry-run import first, import valid profiles, test each imported instance, then keep the old repo data folder until verification is complete.

## v1.0.0 - Initial Public Release

OmniKit v1.0.0 is the first public release of the local-first Omni admin workspace.

### What Ships

- A self-contained React, TypeScript, and Vite app that runs locally in the browser.
- Local API handlers mounted under `/api/*` for Omni admin workflows.
- A versioned in-app walkthrough for non-technical users, with first-run display, sidebar replay, update prompts, and Data Privacy reset controls.
- Dashboard AI & Delivery workflows:
  - AI Content Studio with Dashboard creation, Apps (Beta), narrative reporting, and existing-dashboard review.
  - Dashboard Migrator with compatibility preflight for payload and target-field warnings.
  - Dashboard Operations
  - Dashboard Downloads
  - Deck Builder
- Data & AI Readiness workflows:
  - Connection Health
  - Upload Governance
  - Model & Topic Health
  - Content Health
  - AI Semantic Studio for Omni-native guided semantic authoring.
  - BI Migration Studio as a separate governed workflow for Domo, Power BI, Tableau, Sigma, Looker, WebFOCUS, and MicroStrategy migrations into Omni.
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
- Raw BI Migration Studio files, pasted source text, AI Content Studio attachments, and AI outputs are held in page or encrypted transient memory by default. Saved source/provider profiles use the encrypted native vault; durable AI job metadata excludes prompts, source artifacts, generated YAML, attachments, and credentials.
- Generic proxy forwarding is restricted to approved Omni `/api/v1` paths.
- Other Omni API surfaces use dedicated local handlers.
- The app shell uses bundled assets and system fonts, with no external font CDN dependency.

### Validation

- `npm run typecheck` passed for the React app source.
- `npm run lint` passed with existing Fast Refresh warnings only.
- `npm run build` passed with non-blocking Vite bundle-size and JSZip chunk warnings.
- `npm audit --audit-level=moderate` reported 0 vulnerabilities.
- Release cleanup confirmed no tracked temporary workspace files, generated outputs, environment files, credentials, or local tool artifacts are included.
- The first-party BI migration engine defaults to non-authoritative shadow mode. Primary rollout is source-specific and requires sanitized parity evidence, a named approval, and a completed rollback drill; disabling the source mode restores the native parser immediately.

### Known Notes

- OmniKit is designed for a trusted local operator, not public internet hosting.
- The Vite dev server is for local use only.
- AI Content Studio dashboard review sends an explicitly approved full-dashboard render plus bounded structure evidence to Blobby for a visually grounded critique. The review prompt requests zero writes, while returned actions and scoped model snapshots remain review gates because Omni exposes no server-enforced read-only Agent mode. Dashboard creation candidates require authoritative Documents V2 query-presentation/layout state plus governed query, filter/control, access-list, and content-validator rereads before verification; App output still requires manual App-editor review.
- Verified AI Content Studio test dashboards can be moved only to recoverable Omni Trash after exact operator confirmation; no automatic cleanup runs.
- Apps remain Beta and workbook-backed. Narrative report output is an AI response and chat handoff, not a registered persistent Omni report artifact.
- Uploaded screenshots and PDF references are session-only AI context and remain subject to Omni's AI file-upload settings and the documented request limits.
- Dashboard Migrator compatibility preflight checks payload structure and target-field presence, but it cannot prove that same-named metrics have identical business definitions.
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
