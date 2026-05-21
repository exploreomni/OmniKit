# OmniKit

OmniKit is a self-contained, local-first Omni admin workspace. The UI and local API proxy run on your own machine, with no hosted OmniKit service, no required environment variables, and no telemetry. Your Omni API key is used only for requests to the Omni instance you provide.

---

## Table of contents

1. [What you can do with it](#what-you-can-do-with-it)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [First run — connecting to Omni](#first-run--connecting-to-omni)
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
- Migrate dashboards between Omni connections with base-model mapping and compatibility preflight
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
| Node.js | 18 or newer | Check with `node --version`. Download at [nodejs.org](https://nodejs.org). |
| npm | 9 or newer (bundled with Node) | Yarn or pnpm also work. |
| Browser | Any modern Chromium, Firefox, or Safari | |
| Omni instance | Reachable from your machine | You also need a personal API key. |

No Docker, no database, no backend service, no Supabase account — nothing else to install.

---

## Installation

Step-by-step from zero:

1. **Clone the repo.**
   ```bash
   git clone https://github.com/atx-omni/OmniKit.git
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

## First run — connecting to Omni

When you open the app, you land on the **Connect** screen. Two fields:

1. **Base URL** — the root of your Omni instance, e.g. `https://yourcompany.omniapp.co`. No trailing slash.
2. **API Key** — generate one in Omni under **Settings → API Keys**. Copy the full key.

Click **Test Connection**.

- A green checkmark means you're good — click **Continue**.
- A red error means one of: wrong URL, expired/invalid key, VPN not connected, or your Omni instance blocks requests from localhost. The error message tells you which.

Your key is held in React state and same-tab `sessionStorage` so a refresh does not disconnect you. It is not exported in backups and is cleared when the tab session ends or when you use **Data Privacy → Clear all local data**.

---

## Feature guide

The sidebar groups features by category. Each page is a single workflow with its own wizard or table view.

New users see a click-through walkthrough the first time they open OmniKit. The guide explains how to connect, where each workflow lives, how review steps work, and where local data controls live. Users can dismiss it for the current app version, replay it from the sidebar **Guide** button, or reset it from **Data & Privacy**. When the walkthrough content is updated in a future local clone/pull, OmniKit can show it again for that new version.

### Dashboard AI & Delivery

- **AI Dashboard Studio** — build new dashboard drafts, convert Excel formulas/visuals into guarded dashboard drafts plus model follow-up lists, and review existing dashboards.
  - **Build New Dashboard** starts a first-pass dashboard developer chat from a selected model/topic, audience, KPI list, filters, layout, and color guidance. It routes missing or unsafe metrics back to AI Semantic Studio instead of inventing model fields.
  - **Excel to Dashboard** parses `.xlsx` workbooks in page memory, inventories sheets/formulas/charts, drafts safe dashboard tiles from existing Omni fields, and lists formula/lookup work as AI Semantic Studio follow-ups instead of updating topics or views directly.
  - **Review Existing Dashboard** inspects a live Omni dashboard and returns a review checklist for purpose, UX risks, semantic risks, and Omni UI handoff.
- **Model Migrator** — copy dashboards from one connection to another, or remap dashboards inside one instance. Pick source, pick target, select dashboards, map the base models, run Compatibility Preflight for payload and field-presence warnings, then commit. Warnings can be accepted intentionally; blocked dashboards are skipped. Results are logged to **History**.
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

Every batch run, migration, and bulk operation is appended here with timestamps, status, and a link back to the originating wizard.

### Data Privacy

Exactly what is stored locally, where it's stored (localStorage, IndexedDB, or same-tab sessionStorage), and a single button to wipe everything. Semantic Migration Import source files, pasted source text, and Excel to Dashboard workbooks stay in page memory by default; generated semantic YAML, Blobby responses, dashboard draft handoffs, and operation metadata are stored only if you save or export them through normal OmniKit workflows. Walkthrough progress is stored as a small localStorage flag so returning users are not interrupted repeatedly.

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
- **Stateless handlers.** Each `/api/<name>` route forwards one REST call to your Omni instance using the Base URL and API key you provided. Nothing is cached server-side.
- **Local-only binding.** The server listens on `127.0.0.1`, so nothing else on your LAN can reach it.
- **No database.** Persistent app state lives in your browser (`localStorage` + IndexedDB). The active connection is kept in same-tab `sessionStorage`, which can include your Omni API key for the current browser session and is cleared by the Data Privacy wipe action.
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
| `npm run lint` | Run ESLint. |

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
Open DevTools → Application → Storage → **Clear site data**. Or use the button on the **Data Privacy** page.

---

## Security & privacy

- The local API binds to `127.0.0.1` only — not reachable from other machines on your network.
- Your Omni API key lives in React state and same-tab `sessionStorage` for the current browser session. It is not included in OmniKit backups and is cleared by **Data Privacy → Clear all local data** or by clearing site data in your browser.
- No telemetry, no analytics, no outbound calls except to the Omni Base URL you entered.
- No external font or tracking scripts are loaded by the app shell.
- OmniKit stores operational metadata locally so the UI can show history, templates, filter defaults, and cached dashboard/model context. Open **Data Privacy** to inspect and clear local IndexedDB and localStorage entries.
- Raw export inspection can display the full dashboard export payload in your browser for troubleshooting. Treat copied diagnostics and exported backups as customer data.
- The generic proxy is intentionally limited to Omni `/api/v1` endpoints; workflows that need other Omni API surfaces use purpose-built local handlers.
- Vite's dev server is designed for local development, not for production hosting. Don't expose this app to the public internet.

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
