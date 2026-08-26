# OmniKit

OmniKit is a self-contained, local-first Omni admin workspace. The UI and local API proxy run on your own machine, with no hosted OmniKit service, no required environment variables, and no telemetry. Your Omni API key is used only for requests to the Omni instance you provide.

---

## Table of contents

1. [What you can do with it](#what-you-can-do-with-it)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [First run — setting up your vault](#first-run--setting-up-your-vault)
5. [Feature guide](#feature-guide)
6. [How it works under the hood](#how-it-works-under-the-hood)
7. [Scripts reference](#scripts-reference)
8. [Release & package information](#release--package-information)
9. [Configuration](#configuration)
10. [Troubleshooting](#troubleshooting)
11. [Security & privacy](#security--privacy)
12. [Uninstalling](#uninstalling)
13. [FAQ](#faq)

Security reporting, support boundaries, and contribution requirements are
documented in [SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md), and
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## What you can do with it

- Run governed Dashboard creation and Apps (Beta) jobs, then review and iterate in Omni
- Generate a Narrative report as governed narrative output without claiming a persistent Omni report artifact
- Manage saved Omni instance profiles in a native encrypted local vault
- Use Home as a Fleet Command Center across every saved instance, even when no active working instance is selected
- Compare operational, adoption, content, and exception evidence with exact coverage, freshness, source, and reason details
- Work from four consolidated Administration workspaces while existing Administration URLs continue to resolve with their query state
- Migrate dashboards through one saved-instance copy/import workflow with one or many target instance/connection/model rows
- Bulk copy, move, and delete dashboards across folders
- Download dashboards and build PowerPoint decks from live Omni tiles
- Manage connections, uploads, users, groups, models, topics, labels, schedules, and embeds
- Generate reviewable AI Semantic Studio packages for topics, views, models, and permissions
- Guide non-technical users with a versioned in-app walkthrough that can be dismissed, replayed, or refreshed after a local app update
- Inspect local history and review exactly what OmniKit stores on the Data Privacy page

---

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22.22.0 or newer | CI validates Node 22.22.0. Check with `node --version`. Download at [nodejs.org](https://nodejs.org). |
| npm | 10 or newer (bundled with current Node LTS) | Yarn or pnpm also work. |
| Browser | Current Chromium | Supported for the required local browser checks. Firefox and WebKit remain compatibility targets; see [the browser matrix](docs/support/browser-matrix.md). |
| Omni instance | Reachable from your machine | You also need a personal API key. |

No Docker, database, hosted backend, Supabase account, or Python runtime is required.

---

## Installation

Step-by-step from zero:

1. **Clone the repo.**
   ```bash
   git clone https://github.com/exploreomni/OmniKit.git
   cd OmniKit
   ```
2. **Install dependencies.**
   ```bash
   npm install
   ```
3. **Start the app.**
   ```bash
   npm run dev
   ```
4. **Open it.** Your browser should open automatically at `http://localhost:5173`. If it doesn't, open that URL yourself.

That's it. You now have OmniKit running on one local port, with the API proxy mounted inside the Vite dev server.

---

## First run — setting up your vault

When you open the app, you land on **Home**. Home is the vault-first starting point for OmniKit:

1. **Create or unlock the local encrypted vault.**
2. **Add a saved Omni instance** with a label, role, base URL, and API key.
3. **Review Fleet Command Center** across all saved instances. Fleet is available whenever the vault is unlocked and contains at least one saved instance; it does not require an active working-instance selection.
4. **Choose an active saved instance only when needed** for a connection-dependent Administration, dashboard, model, migration, or delivery workflow.

Your saved instance API keys are encrypted in the native vault and are not returned to the browser as plaintext. The browser keeps only a non-secret vault reference for the active tab session.

If the vault is locked, return to **Home** to unlock it before starting workflows. The sidebar instance switcher shows the selected working instance and supports switching after the vault is unlocked, but passphrase entry stays on Home. Changing that selection does not narrow Fleet; Fleet filters are controlled independently on Home.

A red error usually means one of: wrong URL, expired/invalid key, VPN not connected, unsupported host, or your Omni instance blocks requests from localhost. The error message tells you which.

---

## Feature guide

The sidebar groups features by job. Fleet is the cross-instance operating view, Administration workspaces organize related leaves and tabs, and creation or migration pages keep their focused wizard or table workflow.

New users see a click-through walkthrough the first time they open OmniKit. The guide explains how to start from Home, unlock or create the vault, where each workflow lives, how review steps work, and where local data controls live. Users can dismiss it for the current app version, replay it from the sidebar **Guide** button, or reset it from **Data & Privacy**. When the walkthrough content is updated in a future local clone/pull, OmniKit can show it again for that new version.

### Fleet Command Center

Home is the portfolio operating view for every saved Omni instance in the unlocked vault. It remains available without an active working-instance session. Use the sidebar instance switcher only when entering a workflow that acts on one selected instance.

Fleet has five query-backed views:

1. **Overview** — portfolio KPIs, scan coverage, freshness, and prioritized exceptions.
2. **Operational** — instance reachability, authorization evidence, connection readiness, refresh progress, and failed scans. Collection completeness is not labeled operational health.
3. **Adoption** — 7-, 30-, or 90-day activity plus stale and never-login populations, kept separate from operational readiness.
4. **Content** — connections, models, topics, dashboards, Apps, and AI conversations.
5. **Exceptions** — unavailable, unauthorized, unsupported, stale, failed, and duplicate-origin findings.

Filters support saved instance, explicitly attributed connection, operational or adoption state, freshness, activity window, and text search. Environment/tag filtering is shown as unsupported until a documented governed metadata source exists. Lazy instance and connection drilldowns preserve the supported view, filter, time, and search context when moving into an Administration workflow.

Fleet evidence follows these rules:

- **Unavailable is never zero.** A zero is shown only for a successful, complete read that returned no records. Unauthorized, unsupported, unavailable, failed, partial, and stale evidence remain distinct.
- Every result retains its status, reason code and message, source, coverage, exclusions, and original evidence time. A progressive refresh may show retained stale values, but it does not make their original freshness current. Partial and stale can be true at the same time.
- A failed saved instance does not erase successful totals from other instances; the exact failed and excluded scope stays visible.
- Adoption lifecycle cards count active source records, not unique people. Cross-instance internal-person totals are estimates and can be withheld where governed deduplication is not available.
- Connection relationships are labeled **explicit**, **inferred**, or **unknown**. Only explicit attribution can drive a connection filter or connection-scoped inventory. Inferred and unknown associations are never presented as access or permission evidence.
- Complete portfolio refreshes add one compact encrypted history entry per UTC day. The same day is replaced idempotently, history is bounded to 90 days, and entries exclude raw users, emails, credentials, URLs, and upstream responses.

### AI Content & Dashboard Delivery

- **AI Content Studio** (`/content/ai-studio`) — review an existing dashboard or request new content through one bounded, controlled Omni Agent job from a selected model and optional topic.
  - **Existing-dashboard review** sends an explicitly approved full-dashboard render plus bounded structural evidence to Blobby for an enterprise-polish critique. The render supports visible hierarchy, density, color, labels, and composition findings; hidden behavior, metric correctness, performance, permissions, and responsive states remain unknown unless separately evidenced. The prompt requests zero writes, while returned actions and model snapshots are still reconciled because Omni exposes no server-enforced read-only Agent mode.
  - Agent-backed modes remain controlled writes because Omni does not expose a read-only Agent flag or documented action allowlist. OmniKit binds approval to the exact scope, submits once, retries only status/result reads, and compares model/branch fingerprints after the run.
  - **Dashboard creation** asks Omni Agent to create one persistent first-pass dashboard. A returned reference is only a candidate: OmniKit rereads Documents V2 state and its query presentations/layout containers, governed queries, filters/controls, the complete access list, and content-validator evidence before labeling a dashboard verified. Destination and ownership remain unverified until reconciliation, and optional PNG retrieval proves transport/decoding rather than visual correctness.
  - **Apps (Beta)** asks Omni Agent to start workbook-backed App creation. If Omni returns a Chat handoff, continue there to inspect any candidate reference; the API does not guarantee that the App editor opens. Omni exposes no equivalent typed App verification contract here, so App type, behavior, destination, ownership, and publication remain explicit manual checks.
  - **Narrative report** returns governed narrative output for review; it does not create or claim a persistent Omni report artifact and still uses the controlled-write Agent surface.
  - Verified test dashboards can be moved to recoverable Omni Trash only after the operator checks an exact confirmation and retypes the verified identifier.
  - Optional evidence is limited to five image or PDF attachments. Each image may be no larger than 3 MiB, and the prompt plus decoded attachments must remain approximately 15 MiB or less.
  - Existing bookmarks at `/dashboards/ai-studio` redirect to the canonical AI Content Studio route while preserving query parameters.
- **Dashboard Migrator** — use one simple, non-destructive flow: choose dashboards, choose one or more destinations, then move and track. Every selected dashboard is copied to every selected destination. OmniKit resolves compatible semantic requirements, validates any narrowly safe additive change, verifies query-backed content, and isolates failures by destination without exposing dependency mapping or YAML decisions. Source dashboards remain in place, destination folders are never emptied, direct source sharing is not copied, and same-name collisions receive a deterministic copy suffix instead of replacing or trashing unrelated content. A destination that cannot be proven safe stops with only Retry destination, Choose another model, Open Model Migrator, and collapsed technical details; successful destinations remain untouched.
- **Model Migrator** — migrate semantic models between saved Omni instances through a branch-only workflow. Choose source/target connections, select shared models, map target models, review fast-path versus translate-pipeline YAML changes, port workbook-only query content, and track model/workbook progress in unified job history without exposing API keys in browser payloads. Dashboard selections are carried in the same scope as explicit Dashboard Migrator handoff items.
- **Dashboard Operations** — bulk move, copy, or delete dashboards across folders with confirmation steps and operation logging.
- **Dashboard Downloads** — export one or more dashboards to local files.
- **Deck Builder** — build repeatable PowerPoint decks from live Omni dashboard tiles.

### Deck Builder

Turn any `.pptx` template into a repeatable Omni-powered deck.

1. Upload a `.pptx` template. OmniKit scans it for named placeholders.
2. Map each placeholder to an Omni dashboard tile.
3. Define filter presets (one deck per preset, or one preset across many slides).
4. Run the batch — tiles are fetched live, rendered, and dropped into place.
5. Download the generated `.pptx` files.

Templates, saved batches, dashboard metadata caches, and filter defaults live in your browser's local storage. They stay across restarts until you clear them from the **Data Privacy** page or clear site data in DevTools.

### Administration workspaces

Administration is consolidated into four workspaces. Their landing routes redirect to the first canonical leaf while preserving supported query context.

| Workspace | Canonical routes | Existing aliases retained |
| --- | --- | --- |
| **Fleet & Readiness** | `/admin/fleet`, `/admin/fleet/instances`, `/admin/fleet/connections` | `/instances`, `/connections` |
| **Identity & Access** | `/admin/identity`, `/admin/identity/users`; user, group, bulk-import, and health views use the `tab` query parameter | `/users`, `/groups` |
| **Content Operations** | `/admin/content`, `/admin/content/health`, `/admin/content/schedules`, `/admin/content/uploads`, `/admin/content/labels` | `/content-health`, `/schedules`, `/uploads`, `/labels` |
| **Embed & Developer Tools** | `/admin/developer`, `/admin/developer/embeds` | `/embeds` |

Legacy aliases use replace navigation and preserve their existing query parameters and hash. The `/groups` alias always resolves to the Identity workspace with one `tab=groups` value. Instance Manager is available with an unlocked vault even when no active working instance is selected; connection-dependent leaves still require one.

The workspaces preserve the existing operator workflows:

- **Fleet & Readiness** — save and test encrypted instance profiles, import a compatible legacy vault with a dry run, configure instance defaults and filters, inspect connections, and review folder visibility, aggregate API-token posture, operator-confirmed organization-key posture, and current-token introspection limitations.
- **Identity & Access** — manage users and groups, run bulk import, inspect inactivity and embed-entity activity, review sanitized user-attribute definitions, and request a lazy model-role read for one opaque user or group scope. A returned role assignment is not proof of effective content, row, field, or query access.
- **Content Operations** — inspect folder/document collection evidence, schedules and latest observed delivery state, uploads, labels, and validator/job readiness. Latest delivery evidence is not run history, reliability, or an SLA.
- **Embed & Developer Tools** — review embed-user collection evidence, prepare Standard SSO requests, and follow governed developer or audit-log guidance.

Each workspace has an on-demand **Read-only readiness** panel. It uses documented GET contracts and displays evidence state (`not checked`, `available`, `partial`, `unauthorized`, `unsupported`, `unavailable`, `failed`, or `stale`) separately from readiness (`ready`, `action required`, `not configured`, or `unknown`). Coverage, exclusions, reason, source, and checked time remain visible. Settings without a documented read contract are not guessed or changed; OmniKit provides fixed Omni or documentation links and operator guidance instead.

For Standard SSO, enter the content path, external ID, name, optional email and groups, and embed secret for that request. The secret is sent through the local signing request and cleared after every attempt; OmniKit does not keep a recent signed-URL or secret ledger. Changing any identity-affecting input invalidates the displayed URL. A generated URL confirms that Omni accepted the signing request; it does not prove end-user access.

Workspace navigation, filters, drilldowns, readiness controls, and dialogs are keyboard operable. Use the skip link to move to main content; dialogs keep focus inside while open, close with Escape, and return focus to the opener. Fleet and Administration layouts are designed to remain usable at 320-pixel width without horizontal page overflow.

### Data & AI creation and migration

- **Model & Topic Health** — inspect models, refresh schema context, and review topic coverage for the active working instance.
- **AI Semantic Studio** — build or improve one governed topic solution end to end. OmniKit inventories the model, views, query views, relationships, topic, and optional access work; lets the admin reuse, update, create, or exclude each dependency; generates approved files in dependency order; shows complete pre-write diffs; validates one dev branch; and finishes with a pull-request handoff. Single-file Topic, Model / View, and Permission Builders remain under Advanced.

### Retired source-BI migration workflow

BI Migration Studio is no longer part of OmniKit. Existing `/semantic-migrations`
bookmarks display a retirement notice only and do not load source connectors,
credentials, migration jobs, or the former migration engine. Dashboard Migrator and
Model Migrator remain available for governed Omni-to-Omni work, while AI Semantic
Studio remains available for Omni-native semantic authoring.

### Administration workflow details

- **Labels** in Content Operations — bulk apply or remove labels from selected content.
- **Schedules** in Content Operations — review, pause, resume, trigger, or delete scheduled deliveries. Read-only readiness keeps latest observed delivery evidence separate from mutation controls.
- **User Management** in Identity & Access — manage users and groups, including bulk operations and user-health review for inactive source records or embed entities without active users. Unknown or failed reads do not create false zero-user findings.
- **Embed URLs** in Embed & Developer Tools — generate Standard SSO URLs for approved implementation workflows without retaining the request secret or a recent signed-URL ledger.

### History

Every batch run, migration, and bulk operation is appended here with timestamps and status. Dashboard migration jobs are merged into the same local history view with retry lineage, redacted step details, imported document IDs, semantic-prep audit details, warnings, and post-action results.

### Data Privacy

Exactly what is stored locally, where it's stored (native encrypted vault, local job history, localStorage, IndexedDB, or same-tab sessionStorage), and controls to clear each category. Legacy source and provider credentials retained from the retired BI workflow can be removed separately without resetting saved Omni instances. Walkthrough progress is stored as a small localStorage flag so returning users are not interrupted repeatedly.

---

## How it works under the hood

```
Browser (UI)
   |
   |  fetch('/api/migrate', ...)
   v
Vite dev server on localhost:5173
   |
   |  mounted as middleware
   v
Local API handlers (server/handlers/*.ts)
   |
   |  HTTPS
   v
Your Omni instance
```

Key points:

- **One port, one process.** The Vite plugin at `server/vitePlugin.ts` mounts an Express-style middleware at `/api/*`. No separate backend process.
- **Same-origin.** Because the UI and local API share `localhost:5173`, there is no browser CORS setup and no cookie-based app session to manage.
- **Scoped local handlers.** Most `/api/<name>` routes forward one REST call to your selected Omni instance using either a native-vault reference token or a dedicated saved-instance server-side lookup. Native vault, saved instance, metrics, and migration-job routes run locally and keep secrets on the server side.
- **Local-only binding.** The server listens on `127.0.0.1`, so nothing else on your LAN can reach it.
- **No hosted database.** Persistent app state lives in your browser (`localStorage` + IndexedDB) plus local-only files under `./data/` for the native encrypted vault and sanitized migration job history. The active saved instance is kept in same-tab `sessionStorage` as a non-secret vault reference and is cleared by the Data Privacy wipe action.
- **Native encrypted vault.** Saved Omni instance profiles are encrypted in `./data/vault.enc` by default using Node `crypto` with scrypt and AES-256-GCM. Plaintext API keys are never returned to the browser; UI responses use masked keys only. Writes are atomic — the vault is written to a temp file and renamed, and the previous ciphertext is kept as a single `./data/vault.enc.bak` generation — so an interrupted write or a failed passphrase change cannot destroy your saved credentials. Resetting the vault removes the backup along with the vault itself.
- **Encrypted Fleet history.** Complete portfolio refreshes can retain one compact summary per UTC day in the same encrypted native vault. History is same-day idempotent, bounded to 90 days, and excludes raw identity records, emails, credentials, URLs, and upstream responses. Partial or interrupted scans do not add a daily history entry.
- **Legacy multi-instance cutover.** Instance Manager can import compatible `omni-multi-instance-tools` vault files after the native vault is unlocked. The legacy passphrase is used only for that local import request, valid profiles are re-encrypted into the native vault, duplicate base URLs are skipped, and unsupported legacy-only settings are reported in the dry-run summary.
- **Vault idle auto-lock.** The native vault auto-locks after local server idle time. Override the timeout with `OMNIKIT_VAULT_IDLE_TIMEOUT_MS`. Locking also clears cached Omni content from server memory, so a locked vault is a memory boundary as well as an authorization boundary.
- **Unlock throttling.** Repeated wrong passphrases are rate limited. Five attempts are free, then each further failure arms an exponential backoff up to 30 seconds during which unlock requests are refused with HTTP 429 without checking the passphrase. The counter clears on a successful unlock, on a vault reset, and after 15 minutes with no failures.
- **Local JSON job history.** Multi-instance migration jobs are stored in `./data/omnikit-jobs.json` by default with job metadata, status, warnings, retry lineage, and post-action results. API keys, bearer tokens, card-like numbers, emails, and phone numbers are redacted before job history is written.
- **Compatibility-first proxy guardrails.** The generic proxy only forwards HTTPS requests to Omni `/api/v1` paths. It resolves the target hostname and refuses any host whose DNS answer is a loopback, private, or otherwise special-use address, and it never follows redirects — a redirecting host is reported rather than chased with your credential attached. Other Omni API surfaces used by the app, such as SCIM, embeds, and dashboard import/export, go through dedicated handlers.
- **AI intake is bounded.** AI Content Studio accepts no more than five image or PDF attachments, caps each image at 3 MiB, and caps the UTF-8 prompt plus decoded attachments at approximately 15 MiB.
- **No external app runtime services.** The app uses bundled public assets and system fonts; it does not require a hosted OmniKit backend, package registry service, database, telemetry endpoint, or external font CDN at runtime.

---

## Scripts reference

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite dev server with HMR and the embedded `/api/*` proxy. Use this for day-to-day work. |
| `npm run build` | Build the production bundle into `dist/`. |
| `npm run start` | Build, then serve `dist/` plus the API proxy on a single port. |
| `npm run serve` | Serve an existing `dist/` plus the API proxy (skips rebuild). |
| `npm run preview` | Vite's built-in static preview (UI only, no API). |
| `npm run typecheck` | Run `tsc --noEmit` across the React app source. |
| `npm run typecheck:node` | Run `tsc --noEmit` across the local Node server source. |
| `npm run lint` | Run ESLint. |
| `npm run backup:omnikit-state` | Create a mode-preserving, checksum-bound encrypted-vault backup without reading secrets. |
| `npm run verify:omnikit-backup` | Verify an encrypted backup in an isolated temporary path without overwriting the active vault. |
| `npm run verify:release-governance` | Validate declared owners, support/license decisions, required files, and optional exact-commit repository-policy evidence. |
| `npm run verify:bundle-budgets` | Measure the production manifest against entry, route, chunk, stylesheet, and total JavaScript budgets. |
| `npm run security:licenses` | Enforce the reviewed npm dependency license policy. |
| `npm run security:sbom` | Generate an ignored CycloneDX release SBOM under `artifacts/security/`. |
| `npm run security:supply-chain` | Run npm vulnerability audit, license policy, and SBOM generation. |
| `npm run test:dashboard-safe-copy` | Run the complete non-destructive Dashboard Migrator contract, resolver, runtime, recovery, retry, and frontend-state suite. |
| `npm run test:browser:dashboard-safe-copy` | Run the dedicated three-screen Dashboard Safe Copy Chromium workflow suite. |
| `npm run test:browser:model-migrator-ux` | Run the Model Migrator scope, handoff, cancellation, and target-reset Chromium suite. |
| `npm run test:dashboard-migration` | Run the legacy Dashboard Migrator compatibility suite retained for existing-job recovery and the internal rollback path. |
| `npm run test:migration-planner` | Run focused Dashboard Migrator planner tests. |
| `npm run test:model-migrator` | Run focused Model Migrator inventory helper tests. |
| `npm run test:user-health` | Run focused User Management health tests. |
| `npm run test:workspace-snapshot` | Run focused Home workspace snapshot count tests. |
| `npm run test:fleet-admin:contracts` | Run every focused Fleet and Administration data-truth, readiness, identity, content, SSO, deep-link, and progressive-disclosure contract suite. |
| `npm run test:browser:release` | Run the deterministic Chromium release sequence for Fleet, routing, Administration, UI hardening, Dashboard Safe Copy, Model Migrator, and accessibility. |
| `npm run test:release-gate-coverage` | Verify recursively that the canonical package and CI gates reach every test suite without missing scripts or command cycles. |
| `npm run test:security` | Run focused vault, job-history, and post-action security regression tests. |
| `npm run security:audit` | Run `npm audit --audit-level=moderate`. |
| `npm run security:check` | Run the canonical local release gate: supply-chain controls, focused JavaScript/TypeScript and Chromium suites, typechecks, lint, build, and bundle budgets. |

CI first runs `npm run test:release-gate-coverage`, then invokes the same `npm run security:check` command used locally. The structural guard reads the command graph without launching product tests; it prevents a newly added suite, missing script, or command cycle from silently falling outside the canonical release gate.

### Live E2E gate

Before claiming live-tenant completion or cutting a release, run the automated gate above and spot-check these vault-mode flows against an approved non-production saved instance without destructive actions:

1. Start OmniKit with a short idle timeout, for example `OMNIKIT_VAULT_IDLE_TIMEOUT_MS=10000 npm run dev`.
2. Unlock the native vault with no active working-instance selection and confirm Fleet Command Center still renders all saved-instance evidence.
3. Exercise all five Fleet views, supported filters, and instance/connection drilldowns. Reconcile zero, unavailable, partial, stale, failure, attribution, coverage, source, and freshness labels against the returned API evidence.
4. Open each canonical Administration workspace and its preserved legacy aliases. Verify readiness using read-only controls and inspect any action-required deep links without changing tenant settings.
5. In Embed & Developer Tools, verify Standard SSO validation and confirmation behavior only with an approved non-production test identity and secret-handling procedure; do not retain or capture the secret.
6. Wait for the idle timeout and confirm Home returns to the vault unlock prompt. Unlock again and confirm the prior working-instance selection can resume without altering Fleet scope.
7. Start a migration job only when separately authorized, lock the vault, cancel the running job, and confirm cancel succeeds while retry still requires the vault to be unlocked.

---

## Release & package information

- Release notes live in [RELEASES.md](./RELEASES.md).
- Package and distribution guidance lives in [PACKAGES.md](./PACKAGES.md).
- OmniKit is currently distributed as a source repository. It does not publish a GitHub Package, npm package, Docker image, or hosted service in the initial release.

---

## Configuration

OmniKit is zero-config by design. There are no required environment variables.

Optional:

- `PORT` — override the port used by `npm run serve` / `npm run start`. Default is `5173`.
  ```bash
  PORT=8080 npm run start
  ```
- `OMNIKIT_VAULT_PATH` — override the native encrypted vault path. Default is `./data/vault.enc`.
- `OMNIKIT_VAULT_IDLE_TIMEOUT_MS` — override the native vault idle auto-lock timeout, in milliseconds. Default is `1800000` (30 minutes), capped at `86400000` (24 hours). Blank, zero, negative, and unparseable values fall back to the default rather than disabling the lock, so a declared-but-empty variable cannot silently switch auto-lock off. To disable it for local troubleshooting, set the explicit value `off`.
- `OMNIKIT_JOB_HISTORY_PATH` — override the non-secret migration job history file path. Default is `./data/omnikit-jobs.json`.
- `OMNIKIT_DB_PATH` — legacy alias for `OMNIKIT_JOB_HISTORY_PATH`, kept for older local scripts.
- `OMNIKIT_JOBS_PATH` — legacy one-time import path for older `jobs.json` history. If present and the current job history file is empty, OmniKit imports it and renames it to `jobs.json.bak`.
- `OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS=true` — allow post-migration action templates to call localhost or private-network URLs. By default, post-migration actions must use HTTPS and cannot target private networks.
- `OMNIKIT_POST_ACTION_ALLOWLIST` — optional comma-separated hostname allowlist for post-migration actions, such as `hooks.example.com,automation.example.com`.

---

## Troubleshooting

**Port 5173 is already in use.**
Another process (probably another Vite app) is using the port. Either stop it, or run `PORT=5174 npm run start`.

**Browser didn't open automatically.**
Open `http://localhost:5173` manually.

**Connection test fails.**
Check, in order: the Base URL has no trailing slash and includes the protocol; the API key is the full string with no line breaks; your VPN or SSO is active if Omni is internal-only; your machine can reach the Omni host (`curl -I https://yourcompany.omniapp.co`).

**Deck generation fails.**
Re-upload the `.pptx` template — it may have been saved with an unsupported feature. Confirm the mapped tiles still exist in the source dashboard.

**Blank page after build.**
Run `npm run build` again and watch the terminal for errors. A stale `dist/` can also cause this — delete `dist/` and rebuild.

**I want to wipe everything.**
Open **Data Privacy**. Use **Clear all local data** for browser data, and **Reset native vault** for saved instance profiles and migration job history. Browser DevTools → Application → Storage → **Clear site data** clears browser data only.

**I am moving from `omni-multi-instance-tools`.**
Open **Instance Manager**, unlock or create the native vault, then use **Import legacy multi-instance vault**. Run **Dry run import** first, review skipped duplicates and warnings, then run the import. Test each imported profile before using it in Dashboard Migrator. Keep the old tool's `data/` folder until you have verified the imported instances. Legacy SQLite job history is intentionally kept as an archive in the old repo unless you manually need it for audit reference.

---

## Security & privacy

- The local API binds to `127.0.0.1` only — not reachable from other machines on your network.
- Active saved-instance sessions keep only a non-secret vault reference in React state and same-tab `sessionStorage`. Plaintext saved-instance API keys stay server-side while the native vault is unlocked.
- Saved instance API keys live in the native encrypted vault file, not browser storage. The vault passphrase is not stored, decrypted contents are kept in server memory only while unlocked, the vault auto-locks after idle time, and API keys are returned to the UI only as masked strings.
- Fleet daily history is stored inside the encrypted native vault as compact, privacy-bounded summaries. It retains no raw users, emails, API credentials, tenant URLs, or upstream responses and accepts complete scans only.
- Standard SSO embed secrets are supplied for one local signing request and cleared after every attempt. OmniKit does not persist a recent signed-URL or secret ledger; treat the generated signed URL itself as sensitive and avoid logs, screenshots, issues, or shared browser history.
- Legacy multi-instance vault imports are local file reads only. OmniKit validates the path, requires confirmation before reading absolute paths, skips invalid or duplicate profiles, drops unsafe post-migration action URLs, and never returns imported plaintext API keys to the browser.
- No telemetry, no analytics, no outbound calls except to the Omni Base URL you entered.
- No external font or tracking scripts are loaded by the app shell.
- OmniKit stores operational metadata locally so the UI can show history, templates, filter defaults, cached dashboard/model context, and multi-instance migration jobs. Job history is redacted before it is written to the local JSON history file. Open **Data Privacy** to inspect and clear browser entries, reset the native vault, or clear local job history.
- Post-migration actions are saved as encrypted vault templates and must be explicitly enabled per migration job. Job history stores redacted action metadata only. Actions are HTTPS-only by default, block localhost/private-network targets unless `OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS=true`, and can be restricted with `OMNIKIT_POST_ACTION_ALLOWLIST`.
- Credentials retained from the retired source-BI workflow stay encrypted in the native vault until the operator removes them from **Data Privacy** or resets the vault. They are not loaded by the retirement page.
- Raw export inspection can display the full dashboard export payload in your browser for troubleshooting. Treat copied diagnostics and exported backups as customer data.
- The generic proxy is intentionally limited to Omni `/api/v1` endpoints; workflows that need other Omni API surfaces use purpose-built local handlers.
- Vite's dev server is designed for local development, not for production hosting. Don't expose this app to the public internet.

## Compliance posture

OmniKit is a local-first admin utility, not a certified compliance product.

- **PCI-aware, not PCI certified.** Do not store or process cardholder data in OmniKit unless your environment has been formally scoped for PCI DSS. OmniKit redacts card-like numbers from job history as a safety net, but that does not replace PCI DSS controls or QSA review.
- **SOC readiness support, not a SOC report.** OmniKit can support evidence gathering through local job history, branch review, and explicit migration outcomes, but SOC 1/SOC 2 require organization-level policies, approvals, monitoring, incident response, and auditor testing.
- **CIS-aligned local controls.** OmniKit binds locally, uses encrypted local storage for reusable secrets, avoids telemetry, and includes dependency/security checks. Host-level CIS Benchmark hardening remains the responsibility of the machine and organization running OmniKit.

---

## Uninstalling

1. Close any running `npm run dev` process.
2. Delete the `OmniKit/` folder (including `node_modules/` and `dist/`).
3. Optional: open DevTools on the former URL and **Clear site data** to remove local `omnikit:*` entries.

---

## FAQ

**Does this talk to Supabase or any other cloud service?**
No. OmniKit has no cloud dependencies. The only outbound calls it makes are to the Omni Base URL you provide.

**Can I share my templates or batch history with a teammate?**
Not through the app — it's intentionally single-user. You can export a deck template as a `.pptx` and share that file manually.

**Can I run this on a shared server for my team?**
Not recommended without adding proper authentication, network controls, and operational monitoring. The included API binds to localhost and assumes a single trusted local operator.

**What happens if I close the tab mid-migration?**
The in-flight HTTP request to Omni continues until it finishes or times out, but the UI that was tracking progress is gone. Re-open the tab and check **History** — then re-run anything that didn't complete.

**Do I need to restart the server after editing code?**
No. Vite's HMR picks up UI changes instantly. Changes to files under `server/` trigger a plugin reload automatically.
