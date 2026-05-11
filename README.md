# OmniKit Local

A self-contained, local-only build of OmniKit. The entire app — UI and API proxy — runs on your own machine. No cloud accounts, no hosted services, no environment variables, no telemetry. Your Omni API key and your data never leave your computer.

---

## Table of contents

1. [What you can do with it](#what-you-can-do-with-it)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [First run — connecting to Omni](#first-run--connecting-to-omni)
5. [Feature guide](#feature-guide)
6. [How it works under the hood](#how-it-works-under-the-hood)
7. [Scripts reference](#scripts-reference)
8. [Configuration](#configuration)
9. [Troubleshooting](#troubleshooting)
10. [Security & privacy](#security--privacy)
11. [Uninstalling](#uninstalling)
12. [FAQ](#faq)

---

## What you can do with it

- Migrate dashboards between Omni connections with base-model mapping
- Bulk copy, move, and delete documents across folders
- Download dashboards for local export
- Build PowerPoint decks from `.pptx` templates populated with live dashboard tiles
- Manage connections, uploads, users, groups, models, topics, labels, schedules, and embeds
- Inspect past runs in a local history log
- Review exactly what OmniKit Local stores on the Data Privacy page

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

1. **Get the folder.** Copy the `OmniKit-Local/` directory to wherever you want it on your machine (e.g. `~/dev/OmniKit-Local`).
2. **Open a terminal in that folder.**
   ```bash
   cd OmniKit-Local
   ```
3. **Install dependencies.**
   ```bash
   npm install
   ```
   This takes about a minute the first time.
4. **Start the app.**
   ```bash
   npm run dev
   ```
5. **Open it.** Your browser should open automatically at `http://localhost:5173`. If it doesn't, open that URL yourself.

That's it. You now have the full app running on one port, with the API proxy mounted inside the Vite dev server.

---

## First run — connecting to Omni

When you open the app, you land on the **Connect** screen. Two fields:

1. **Base URL** — the root of your Omni instance, e.g. `https://yourcompany.omniapp.co`. No trailing slash.
2. **API Key** — generate one in Omni under **Settings → API Keys**. Copy the full key.

Click **Test Connection**.

- A green checkmark means you're good — click **Continue**.
- A red error means one of: wrong URL, expired/invalid key, VPN not connected, or your Omni instance blocks requests from localhost. The error message tells you which.

Your key lives only in a React context in memory for the session. Close the tab and it's gone. It is never written to disk.

---

## Feature guide

The sidebar groups features by category. Each page is a single workflow with its own wizard or table view.

### Dashboards

- **Migrate** — copy dashboards from one connection to another. Pick source, pick target, select dashboards, map the base models, preview the dry-run diff, then commit. Results are logged to **History**.
- **Bulk Move** — select many documents, pick a destination folder, confirm.
- **Bulk Copy** — same as Move, but keeps the originals. Optional rename suffix.
- **Bulk Delete** — select documents, confirm twice. Deletion is permanent in Omni, so review the summary carefully.
- **Downloads** — export one or more dashboards to local files.

### Deck Builder

Turn any `.pptx` template into a repeatable Omni-powered deck.

1. Upload a `.pptx` template. OmniKit Local scans it for named placeholders.
2. Map each placeholder to an Omni dashboard tile.
3. Define filter presets (one deck per preset, or one preset across many slides).
4. Run the batch — tiles are fetched live, rendered, and dropped into place.
5. Download the generated `.pptx` files.

Templates and saved batches live in your browser's IndexedDB; they stay across restarts until you clear site data.

### Admin

- **Connections** — view and edit database connections on your Omni instance.
- **Uploads** — manage uploaded datasets.
- **Users / Groups** — user and group administration.
- **Models / Topics / Labels** — schema and semantic-layer management.
- **Schedules** — review scheduled deliveries.
- **Embeds** — generate signed embed URLs for dashboards.

### History

Every batch run, migration, and bulk operation is appended here with timestamps, status, and a link back to the originating wizard.

### Data Privacy

Exactly what is stored locally, where it's stored (localStorage vs IndexedDB), and a single button to wipe everything.

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
- **Same-origin.** Because the UI and API share `localhost:5173`, there is no CORS, no auth header, no cookies to worry about.
- **Stateless handlers.** Each `/api/<name>` route forwards one REST call to your Omni instance using the Base URL and API key you provided. Nothing is cached server-side.
- **Local-only binding.** The server listens on `127.0.0.1`, so nothing else on your LAN can reach it.
- **No database.** All persistent state lives in your browser (`localStorage` + IndexedDB under the `omnikit:*` prefix).

---

## Scripts reference

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite dev server with HMR and the embedded `/api/*` proxy. Use this for day-to-day work. |
| `npm run build` | Build the production bundle into `dist/`. |
| `npm run start` | Build, then serve `dist/` plus the API proxy on a single port. |
| `npm run serve` | Serve an existing `dist/` plus the API proxy (skips rebuild). |
| `npm run preview` | Vite's built-in static preview (UI only, no API). |
| `npm run typecheck` | Run `tsc --noEmit` across app and server. |
| `npm run lint` | Run ESLint. |

---

## Configuration

OmniKit Local is zero-config by design. There are no required environment variables.

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
- Your Omni API key lives in React memory for the session and is never written to disk.
- No telemetry, no analytics, no outbound calls except to the Omni Base URL you entered.
- Vite's dev server is designed for local development, not for production hosting. Don't expose this app to the public internet.

---

## Uninstalling

1. Close any running `npm run dev` process.
2. Delete the `OmniKit-Local/` folder (including `node_modules/` and `dist/`).
3. Optional: open DevTools on the former URL and **Clear site data** to remove local `omnikit:*` entries.

---

## FAQ

**Does this talk to Supabase or any other cloud service?**
No. OmniKit Local has no cloud dependencies. The only outbound calls it makes are to the Omni Base URL you provide.

**Can I share my templates or batch history with a teammate?**
Not through the app — it's intentionally single-user. You can export a deck template as a `.pptx` and share that file manually.

**Can I run this on a shared server for my team?**
Not recommended. The API binds to localhost and trusts whoever is using the browser. For a multi-user deployment, use the hosted version of OmniKit.

**What happens if I close the tab mid-migration?**
The in-flight HTTP request to Omni continues until it finishes or times out, but the UI that was tracking progress is gone. Re-open the tab and check **History** — then re-run anything that didn't complete.

**Do I need to restart the server after editing code?**
No. Vite's HMR picks up UI changes instantly. Changes to files under `server/` trigger a plugin reload automatically.
