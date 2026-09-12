export interface DashboardWorkbookCopyCapabilityCheck {
  id: 'production_adapter' | 'effective_access' | 'new_file_conflicts';
  status: 'not_verified';
  category: 'implementation' | 'contract_guarantee';
  title: string;
  detail: string;
  requiredEvidence: string;
  documentation: Array<{ title: string; url: string }>;
}

export interface DashboardWorkbookCopyCapability {
  supported: false;
  code: 'WORKBOOK_COPY_CAPABILITY_UNVERIFIED';
  status: 'implementation_blocked';
  tenantAccessAssessment: 'not_assessed';
  message: string;
  checks: DashboardWorkbookCopyCapabilityCheck[];
  requiredEvidence: string[];
  documentation: string[];
  transportCandidates: Array<{ title: string; detail: string; documentation: Array<{ title: string; url: string }> }>;
  handoff: string;
}

/**
 * Build capability, not a tenant permission probe or caller-supplied approval.
 * Return fresh data so presentation consumers cannot alter the server's closed gate.
 * No plan choice, folder selection, or checkbox can enable workbook-copy dispatch.
 */
export function getDashboardWorkbookCopyCapability(): DashboardWorkbookCopyCapability {
  const checks: DashboardWorkbookCopyCapabilityCheck[] = [
    {
      id: 'production_adapter', status: 'not_verified', category: 'implementation',
      title: 'Production copy adapter',
      detail: 'Omni documents draft workbook identities and workbook YAML writes, but this build has no enabled production adapter connecting them to verified copy, publication, and delivery.',
      requiredEvidence: 'A reviewed adapter and explicitly authorized pilot proving workbook-local definitions, queries, content, source access policy, publication policy, shared-model non-modification, final delivery, and uncertain-write recovery.',
      documentation: [
        { title: 'Read a named draft', url: 'https://docs.omni.co/api/documents-v2/get-draft-state' },
        { title: 'Publish the main draft', url: 'https://docs.omni.co/api/documents-v2/publish-draft' },
      ],
    },
    {
      id: 'effective_access', status: 'not_verified', category: 'contract_guarantee',
      title: 'Staging and delivery access proof',
      detail: 'The first document create is already published. The documented per-user folder permission read alone does not establish complete inherited, group, organization, and public access. A folder name or restricted setting is not that proof.',
      requiredEvidence: 'Authoritative complete effective access evidence before the first create, plus verified source security and approved final-audience policy before delivery. This capability check has not tested or rejected this tenant’s permissions.',
      documentation: [
        { title: 'Create and publish a document', url: 'https://docs.omni.co/api/documents-v2/create-document' },
        { title: 'Read folder permissions for a user', url: 'https://docs.omni.co/api/folder-permissions/get-folder-permissions' },
        { title: 'Sharing and inherited access', url: 'https://docs.omni.co/share' },
      ],
    },
    {
      id: 'new_file_conflicts', status: 'not_verified', category: 'contract_guarantee',
      title: 'New workbook-file conflict protection',
      detail: 'The YAML API supports previousChecksum for conflict detection. The reviewed contract does not establish an absent-file precondition for a new destination file; omitting a checksum is not proof against a concurrent overwrite.',
      requiredEvidence: 'A documented and verified create-if-absent or equivalent isolation guarantee for new workbook files, or a reviewed native-copy route that avoids this individual-file write requirement.',
      documentation: [
        { title: 'Create or update model YAML', url: 'https://docs.omni.co/api/models/create-or-update-yaml-files' },
      ],
    },
  ];
  const transportCandidates = [
    {
      title: 'Native document duplication',
      detail: 'The official CLI documents a duplicate command. Its command reference alone does not establish target-model rebinding or security preservation for this migration workflow; no duplicate adapter is enabled.',
      documentation: [{ title: 'Document commands', url: 'https://docs.omni.co/developers/cli/commands/documents' }],
    },
    {
      title: 'Content migration API — Beta',
      detail: 'Export/import carries a workbookModel and supports a destination base model. It is Beta and requires an organization API key. The reviewed contract does not establish atomic publication, access preservation, or conditional-create recovery; it is not an automatic fallback.',
      documentation: [
        { title: 'Export a dashboard (Beta)', url: 'https://docs.omni.co/api/content-migration/export-dashboard' },
        { title: 'Import a dashboard (Beta)', url: 'https://docs.omni.co/api/content-migration/import-dashboard' },
      ],
    },
  ];
  return {
    supported: false,
    code: 'WORKBOOK_COPY_CAPABILITY_UNVERIFIED',
    status: 'implementation_blocked',
    tenantAccessAssessment: 'not_assessed',
    message: 'Automated workbook-local copy is unavailable in this OmniKit build: the production adapter and required access and write-conflict guarantees are not verified. This is a capability gap, not a finding that this tenant denied access. Keep local definitions in their source workbook; do not promote them to the shared model.',
    checks,
    requiredEvidence: checks.map((check) => check.requiredEvidence),
    documentation: [...new Set([...checks, ...transportCandidates].flatMap((item) => item.documentation.map((link) => link.url)))],
    transportCandidates,
    handoff: 'Keep the source workbook unchanged. Ask the Omni administrator and implementation owner to review a separate supported copy workflow, its workbook-local definitions, and source and destination access policies. Record the result and recheck readiness; an acknowledgement here cannot enable automatic copying.',
  };
}
