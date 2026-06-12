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

---

## What you can do with it

- Build first-pass dashboards with Blobby, then finish review and iteration in Omni chat
- Convert Excel workbooks into guarded dashboard drafts and semantic follow-up plans
- Review existing dashboards with AI-assisted readiness checks and admin-friendly recommendations
- Manage saved Omni instance profiles in a native encrypted local vault
- Track multi-instance connection and embed-user metrics with internal/test filters
- Migrate dashboards through same-instance model remap or saved-instance copy/import with multi-destination fan-out
- Bulk copy, move, and delete dashboards across folders
- Download dashboards and build PowerPoint decks from live Omni tiles
- Manage connections, uploads, users, groups, models, topics, labels, schedules, and embeds
- Generate reviewable AI Semantic Studio packages for topics, views, models, and permissions
- Import dbt, Looker, Power BI, Tableau, or Domo semantic artifacts into AI Semantic Studio to generate reviewed Omni semantic YAML
- Guide non-technical users with a versioned in-app walkthrough that can be dismissed, replayed, or refreshed after a local app update
- Inspect local history and review exactly what OmniKit stores on the Data Privacy page

---

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 20 or newer | CI validates Node 20. Check with `node --version`. Download at [nodejs.org](https://nodejs.org). |
| npm | 10 or newer (bundled with current Node LTS) | Yarn or pnpm also work. |
| Browser | Any modern Chromium, Firefox, or Safari | |
| Omni instance | Reachable from your machine | You also need a personal API key. |

No Docker, no database, no backend service, no Supabase account — nothing else to install.

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
   This takes about a minute the first time.
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
3. **Choose the saved instance** you want OmniKit workflows to use.

Your saved instance API keys are encrypted in the native vault and are not returned to the browser as plaintext. The browser keeps only a non-secret vault reference for the active tab session.

If the vault is locked, return to **Home** to unlock it before starting workflows. The sidebar instance switcher shows the selected saved instance and supports switching after the vault is unlocked, but passphrase entry stays on Home.

A red error usually means one of: wrong URL, expired/invalid key, VPN not connected, unsupported host, or your Omni instance blocks requests from localhost. The error message tells you which.

---

## Feature guide

The sidebar groups features by category. Each page is a single workflow with its own wizard or table view.

New users see a click-through walkthrough the first time they open OmniKit. The guide explains how to start from Home, unlock or create the vault, where each workflow lives, how review steps work, and where local data controls live. Users can dismiss it for the current app version, replay it from the sidebar **Guide** button, or reset it from **Data & Privacy**. When the walkthrough content is updated in a future local clone/pull, OmniKit can show it again for that new version.

### Dashboard AI & Delivery

- **AI Dashboard Studio** — build new dashboard drafts, convert Excel formulas/visuals into guarded dashboard drafts plus model follow-up lists, and review existing dashboards.
  - **Build New Dashboard** starts a first-pass dashboard developer chat from a selected model/topic, audience, KPI list, filters, layout, and color guidance. It routes missing or unsafe metrics back to AI Semantic Studio instead of inventing model fields.
  - **Excel to Dashboard** parses `.xlsx` workbooks in page memory, inventories sheets/formulas/charts, drafts safe dashboard tiles from existing Omni fields, and lists formula/lookup work as AI Semantic Studio follow-ups instead of updating topics or views directly.
  - **Review Existing Dashboard** inspects a live Omni dashboard and returns a review checklist for purpose, UX risks, semantic risks, and Omni UI handoff.
- **Model Migrator** — use **Within this instance** when dashboards stay inside the connected Omni instance and only need base-model remapping. Use **To other saved instances** for the fan-out wizard: unlock the native vault, pick one saved source/model/dashboard set, check one or more destination instances, confirm each destination model/folder, run a preflight matrix, and monitor live per-destination progress. The fan-out path preserves descriptions and labels where Omni supports it, records per-step job status, and lets failed destinations be retried without rerunning successful work.
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

### Data & AI Readiness

- **Instance Manager** — create a native encrypted local vault, save source/destination Omni instance profiles, test saved credentials, import compatible legacy multi-instance vaults with a dry run, configure default models/folders, define tag-based internal/test filters, store validated HTTPS post-migration action templates, refresh schema models, and scan connection or embed-user activity metrics across saved instances.
- **Connection Health** — validate Omni connectivity and inspect core account readiness signals.
- **Upload Governance** — review uploaded datasets, ownership, freshness, and governance signals.
- **Model & Topic Health** — validate models and inspect topic coverage.
- **Content Health** — scan dashboard and workbook dependency health.
- **AI Semantic Studio** — review and generate governed semantic-layer packages for Topic Builder, Model / View Builder, and Permission Builder workflows. The Semantic Migration Import mode accepts dbt, Looker, Power BI, Tableau, and Domo source artifacts, parses them locally, and asks Blobby to generate Omni semantic YAML only. OmniKit saves generated YAML to a dev branch for validation, shows lint/content checks, and leaves final promotion in Omni's model editor.

### Governance

- **Labels** — bulk apply or remove labels from selected content.
- **Schedules** — review, pause, resume, trigger, or delete scheduled deliveries.
- **User Management** — manage users and groups, including bulk user operations.
- **Embed URLs** — generate signed embed URLs for approved implementation workflows.

### History

Every batch run, migration, and bulk operation is appended here with timestamps and status. Fan-out migration jobs are merged into the same local history view with retry lineage, redacted step details, imported document IDs, warnings, and post-action results.

### Data Privacy

Exactly what is stored locally, where it's stored (native encrypted vault, local job history, localStorage, IndexedDB, or same-tab sessionStorage), and controls to clear each category. Semantic Migration Import source files, pasted source text, and Excel to Dashboard workbooks stay in page memory by default; generated semantic YAML, Blobby responses, dashboard draft handoffs, and operation metadata are stored only if you save or export them through normal OmniKit workflows. Walkthrough progress is stored as a small localStorage flag so returning users are not interrupted repeatedly.

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
- **Native encrypted vault.** Saved Omni instance profiles are encrypted in `./data/vault.enc` by default using Node `crypto` with scrypt and AES-256-GCM. Plaintext API keys are never returned to the browser; UI responses use masked keys only.
- **Legacy multi-instance cutover.** Instance Manager can import compatible `omni-multi-instance-tools` vault files after the native vault is unlocked. The legacy passphrase is used only for that local import request, valid profiles are re-encrypted into the native vault, duplicate base URLs are skipped, and unsupported legacy-only settings are reported in the dry-run summary.
- **Vault idle auto-lock.** The native vault auto-locks after local server idle time. Override the timeout with `OMNIKIT_VAULT_IDLE_TIMEOUT_MS`.
- **Local SQLite job history.** Multi-instance migration jobs are stored in `./data/omnikit.db` by default with job metadata, status, warnings, retry lineage, and post-action results. API keys, bearer tokens, card-like numbers, emails, and phone numbers are redacted before job history is written.
- **Compatibility-first proxy guardrails.** The generic proxy only forwards HTTPS requests to Omni `/api/v1` paths. Other Omni API surfaces used by the app, such as SCIM, embeds, and dashboard import/export, go through dedicated handlers.
- **AI intake is local-first.** Uploaded dbt, Looker, Power BI, Tableau, and Domo artifacts, plus Excel workbooks used by AI Dashboard Studio, are parsed in the browser and held in memory for the active page session. OmniKit does not write raw external BI source files or raw Excel workbooks to IndexedDB or localStorage by default.
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
| `npm run test:fanout` | Run focused Model Migrator fan-out wizard helper tests. |
| `npm run test:security` | Run focused vault, job-history, and post-action security regression tests. |
| `npm run security:audit` | Run `npm audit --audit-level=moderate`. |
| `npm run security:check` | Run the full local security gate: audit, security tests, typechecks, lint, and build. |

### Live E2E gate

Before cutting a release, run the automated gate above and spot-check these vault-mode flows against a real saved instance:

1. Start OmniKit with a short idle timeout, for example `OMNIKIT_VAULT_IDLE_TIMEOUT_MS=10000 npm run dev`.
2. Unlock the native vault, connect a saved instance, wait for the idle timeout, and confirm Home shows the vault unlock prompt instead of **Connected workspace**.
3. Unlock from the sidebar instance switcher and confirm the previous saved instance resumes without re-selecting it.
4. Start a migration job, lock the vault, cancel the running job, and confirm cancel succeeds while retry still requires the vault to be unlocked.

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
- `OMNIKIT_VAULT_IDLE_TIMEOUT_MS` — override the native vault idle auto-lock timeout. Default is `1800000` (30 minutes). Use `0` only for local troubleshooting when you explicitly want to disable auto-lock.
- `OMNIKIT_DB_PATH` — override the non-secret migration job history database path. Default is `./data/omnikit.db`.
- `OMNIKIT_JOBS_PATH` — legacy one-time import path for older `jobs.json` history. If present and the SQLite database is empty, OmniKit imports it and renames it to `jobs.json.bak`.
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
Open **Instance Manager**, unlock or create the native vault, then use **Import legacy multi-instance vault**. Run **Dry run import** first, review skipped duplicates and warnings, then run the import. Test each imported profile before using it in Model Migrator. Keep the old tool's `data/` folder until you have verified the imported instances. Legacy SQLite job history is intentionally kept as an archive in the old repo unless you manually need it for audit reference.

---

## Security & privacy

- The local API binds to `127.0.0.1` only — not reachable from other machines on your network.
- Your Omni API key lives in React state and same-tab `sessionStorage` for the current browser session. It is not included in OmniKit backups and is cleared by **Data Privacy → Clear all local data** or by clearing site data in your browser.
- Saved instance API keys live in the native encrypted vault file, not browser storage. The vault passphrase is not stored, decrypted contents are kept in server memory only while unlocked, the vault auto-locks after idle time, and API keys are returned to the UI only as masked strings.
- Legacy multi-instance vault imports are local file reads only. OmniKit validates the path, requires confirmation before reading absolute paths, skips invalid or duplicate profiles, drops unsafe post-migration action URLs, and never returns imported plaintext API keys to the browser.
- No telemetry, no analytics, no outbound calls except to the Omni Base URL you entered.
- No external font or tracking scripts are loaded by the app shell.
- OmniKit stores operational metadata locally so the UI can show history, templates, filter defaults, cached dashboard/model context, and multi-instance migration jobs. Job history is redacted before it is written to the local SQLite file. Open **Data Privacy** to inspect and clear browser entries, reset the native vault, or clear local job history.
- Post-migration actions are saved as encrypted vault templates and must be explicitly enabled per migration job. Job history stores redacted action metadata only. Actions are HTTPS-only by default, block localhost/private-network targets unless `OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS=true`, and can be restricted with `OMNIKIT_POST_ACTION_ALLOWLIST`.
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
