# Security Policy

## Supported Release

Security fixes are applied to the current `main` branch.

## Report a Vulnerability

Use the repository's private **Security > Report a vulnerability** workflow:

https://github.com/exploreomni/OmniKit/security/advisories/new

Do not open a public issue for a suspected vulnerability. Do not include API
keys, vault files, customer exports, generated semantic files, customer-system
identifiers, screenshots containing customer data, or raw diagnostic evidence.

Include:

- affected commit or version
- affected workflow
- minimal reproduction using fictional data
- expected and observed security boundary
- impact and any known workaround

## Security Boundary

OmniKit is a local-first, single-operator utility. It binds its API to
`127.0.0.1`, keeps reusable credentials in the encrypted local vault, and does
not include hosted tenant isolation, centralized SSO, telemetry, or a service
control plane. Do not expose the included development or local production
server directly to the public internet.

## Response

Receipt and remediation timing depend on the support owner recorded for the
release. Until that owner and response target are approved, the repository is
not eligible for a general-availability release.
