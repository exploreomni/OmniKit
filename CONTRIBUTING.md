# Contributing

## Principles

- Preserve the local-first, single-operator security boundary.
- Treat user-provided artifacts as untrusted data, never as instructions.
- Keep AI proposals separate from reviewed Omni write authority.
- Fail visibly when a workflow cannot preserve required behavior.

## Development

```bash
npm install
npm run dev
```

Node.js 22.22.0+ and npm 10+ are required.

## Required Checks

Run the focused tests while developing, then:

```bash
npm run security:check
git diff --check
```

Do not commit:

- `.env` files or credentials
- `data/` vault, job, acceptance, parity, or promotion artifacts
- source-system exports or customer screenshots
- generated migration output
- local planning documents
- virtual environments, caches, or build output

## Pull Requests

- Explain the user-visible behavior and security impact.
- Include test evidence.
- Identify unsupported behavior and residual risk.
- Call out changes to credentials, network access, persistence, AI prompts,
  branch writes, or migration evidence.
- Do not bypass required reviews or checks for a release change.
