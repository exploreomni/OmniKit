# Packages And Distribution

OmniKit is currently distributed as a source repository, not as a published package or hosted service.

## Current Distribution

- Clone from GitHub: `https://github.com/atx-omni/OmniKit.git`
- Install dependencies with `npm install`.
- Run locally with `npm run dev`.
- Build locally with `npm run build`.
- Serve a local production build with `npm run start` or `npm run serve`.

The repository includes the source code and lockfile needed to reproduce the app locally.

The source distribution includes:

- React/Vite UI source under `src/`
- Local Omni API handlers under `server/`
- Bundled public image/SVG assets under `public/`
- Documentation for setup, releases, package strategy, privacy, and security posture
- The npm lockfile for reproducible local installs

The source distribution intentionally does not include generated build output, temporary migration files, user-supplied workbooks, API keys, local browser data, or operator-specific exports.

## GitHub Packages

OmniKit does not currently publish a GitHub Package.

This is intentional for the initial release because the operator workflow is clone-and-run:

- No npm package is required.
- No Docker image is required.
- No hosted backend is required.
- No package registry credentials are required.

## npm Package

OmniKit is not currently published to npm.

The `package.json` file is application metadata for local installation and scripts. It is not intended as a reusable library package.

## Build Artifacts

Build and runtime artifacts are intentionally excluded from the repository:

- `node_modules/`
- `dist/`
- `output/`
- `tmp/`
- logs
- environment files
- workspace-specific folders

Each operator should build artifacts locally from source.

AI Dashboard Studio Excel workbooks and AI Semantic Studio source artifacts are treated as user-provided working data. They are parsed in the browser for the active page session and should not be committed to the repository unless a future release explicitly adds curated fixtures.

## Release Assets

No binary release assets are required for v1.0.0. The recommended package is the GitHub source repository itself.

Recommended install path:

```bash
git clone https://github.com/atx-omni/OmniKit.git
cd OmniKit
npm install
npm run dev
```

## Future Packaging Options

If OmniKit needs a more formal distribution model later, the safest next options are:

- A signed GitHub Release source archive.
- A Docker image for controlled internal deployments.
- A desktop wrapper for single-user local operation.
- A hosted multi-user version with authentication, network controls, logging, and operational monitoring.

Do not expose the current local-first app directly to the public internet.
