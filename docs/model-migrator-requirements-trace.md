# Model Migrator Requirements Trace

Last updated: 2026-06-13

This trace is the control document for completing the net-new Model Migrator workflow slowly and accurately. Each phase should update this file before moving to the next requirement cluster.

## Status Legend

- Captured: implemented and covered by at least one local validation path.
- Partial: implemented shape exists, but fidelity, tests, or UX completeness remain.
- Missing: not implemented yet.
- Deferred: intentionally outside V1 or blocked by live API spike.

## Functional Requirements

| ID | Requirement Summary | Status | Evidence / Remaining Work |
| --- | --- | --- | --- |
| FR-1 | Sidebar entry, route, RequireConnection, walkthrough | Captured | `/models/migrate`, sidebar, page map, walkthrough version are implemented. |
| FR-2 | Vault-first saved instances only | Captured | Model Migrator handler requires unlocked native vault; UI uses saved instances only. |
| FR-3 | Dropdown-driven source/target connection/model selection | Captured | Source and target instance, connection, and model selectors are dropdowns with source multi-select. |
| FR-4 | Per-model git status, model kind, content counts | Captured | Source model list shows kind, git eligibility, and inventory counts. |
| FR-5 | Fast path with schema assertion, gitRef, branchName | Captured | Fast path requires schema confirmation, supports optional git ref, and uses branchName. Needs live fast-path E2E. |
| FR-6 | Fast path requires git-backed source model | Captured | UI gates fast path on git metadata and server requires explicit fast-path confirmation. |
| FR-7 | Read source YAML with checksums | Captured | Translate endpoint loads YAML with checksums. |
| FR-8 | Deterministic schema/quote rewrites and connection warnings | Captured | Explicit schema-map rewrites support quoted schema references; connection-sensitive settings emit review warnings. |
| FR-9 | AI dialect pass via Semantic Studio/AI job machinery | Captured | Vault-backed Omni AI job orchestration is isolated in `modelMigration/aiTranslation`, skips non-SQL files, captures AI job IDs/refusals, and has result/refusal parsing tests. Live repair/retry parity is covered by Phase 10. |
| FR-10 | Per-file diff review with accept/edit/skip and session persistence | Captured | Review shows original, deterministic draft, AI draft, and accepted output. Users must explicitly accept/edit or skip each file; translation outputs and decisions persist through sanitized sessionStorage. |
| FR-11 | Create target branch, batch YAML writes, validate | Captured | Target branch creation, batched branch YAML writes, and validation are implemented. Needs live branch lifecycle E2E. |
| FR-12 | Branch-only writes and separate human merge after validation | Captured | Initial jobs apply and validate only. Merge is an explicit post-validation API/UI action; failed validation blocks merge; PR/git-protected models produce handoff warnings without forcing settings. |
| FR-13 | Content inventory with dashboard/workbook classes and metadata flags | Captured | Inventory, search/select, counts, labels/description indicators are implemented. |
| FR-14 | Dashboard Migrator parity in one continuous job | Captured | Model jobs run dashboard export/import/metadata, replace-same-named, label creation, folder verification, and field-reference preflight. Live beta export/import E2E still required. |
| FR-15 | Fetch workbook document queries | Captured | `workbook_queries` uses `GET /documents/{id}/queries`. |
| FR-16 | Rewrite workbook model references and field preflight | Captured | Query rewrite and field-universe preflight exist. Needs live query portability spike. |
| FR-17 | Create target workbook documents with queryPresentations | Captured | `workbook_create` posts query presentations and replace-same-named behavior. Needs live visConfig fidelity spike. |
| FR-18 | Honest workbook fidelity and tab-level reporting | Captured | Result details list each tab, carried query/description/visConfig fields, target document links, limitations, and document-level retry boundaries when Omni create fails. |
| FR-19 | Workbook job item kinds and engine integration | Captured | Workbook job kinds use SSE/history/retry/cancel/redaction. |
| FR-20 | Target content validation punch list | Captured | Validate-content responses are normalized into severity/status/message/document/field/view/link issue rows and rendered in the run board. |
| FR-21 | One job, History, retry lineage, OperationLog | Captured | One job, History detail, SSE, retry lineage, item-level OperationLog entries, and local history reload preservation tests are implemented. |
| FR-22 | Refresh schema and webhook post-actions | Captured | Model Migrator surfaces target schema refresh and saved post-action templates. |

## Non-Functional Requirements

| ID | Requirement Summary | Status | Evidence / Remaining Work |
| --- | --- | --- | --- |
| NFR-1 | Vault-backed security and redaction | Captured | Handler requires vault unlock; security tests cover locked/incomplete/no-secret responses. |
| NFR-2 | Rate limits and batched YAML writes | Captured | OmniClient limiter applies; branch YAML writes use batch payload. |
| NFR-3 | Resumability and crash recovery | Captured | Sanitized session draft persists review outputs/decisions, and local history reload tests preserve model job details and retry lineage. |
| NFR-4 | Honest copy and unsupported artifact disclosure | Captured | Run results disclose schedules, alerts, permissions, sharing, favorites, and non-exposed workbook artifacts as not automatically moved. |
| NFR-5 | A11y/polish | Captured | Error banners use `role="alert"`, status messages use `aria-live`, and the workflow remains dropdown-first with loading/empty states. |
| NFR-6 | Effort guidance | Captured | This phased trace controls the remaining work. |

## Acceptance Criteria Status

| Criterion | Status | Notes |
| --- | --- | --- |
| Customer E2E Snowflake to Databricks with models, 5 dashboards, 5 workbooks | Missing | Phase 10 live gate. |
| Fast path git-backed model to named branch with explicit merge | Partial | Implementation and explicit merge action exist; needs live fast-path E2E. |
| Translate pipeline produces reviewable diff and never writes before accept | Captured | Local behavior captured with original/deterministic/AI/accepted review, explicit accept/edit/skip, sanitized draft restore, and blocked writes. Live Snowflake-to-Databricks validation loop remains Phase 10 proof. |
| Workbook absent-field blocker is caught before run | Captured | Preflight blocks run when blockers exist. |
| One History job with cancel/retry and green `security:check` | Captured | History, retry lineage, reload persistence, cancel/retry safety, and security gate coverage are implemented locally. |
