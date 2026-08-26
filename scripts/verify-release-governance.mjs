import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const defaultProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const requiredGovernanceFiles = [
  'SECURITY.md',
  'SUPPORT.md',
  'CONTRIBUTING.md',
  'THIRD_PARTY_NOTICES.md',
  '.github/CODEOWNERS',
];

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function validateGovernanceConfiguration(governance) {
  const errors = [];
  if (!governance || typeof governance !== 'object' || Array.isArray(governance)) {
    return ['governance configuration must be an object'];
  }
  if (governance.schemaVersion !== 'omnikit.release-governance.v1') {
    errors.push('schemaVersion must be omnikit.release-governance.v1');
  }
  for (const field of ['releaseOwner', 'supportOwner', 'securityOwner', 'supportResponseTarget']) {
    if (governance[field] !== null && !nonEmptyString(governance[field])) {
      errors.push(`${field} must be a non-empty string or null`);
    }
  }
  const license = governance.rootLicense;
  if (!license || !['pending_legal_approval', 'approved'].includes(license.status)) {
    errors.push('rootLicense.status must be pending_legal_approval or approved');
  }
  if (!nonEmptyString(license?.decisionRecord)) {
    errors.push('rootLicense.decisionRecord must identify the decision record');
  }
  if (license?.status === 'approved' && !nonEmptyString(license.spdx)) {
    errors.push('an approved root license must include an SPDX identifier');
  }
  if (license?.status !== 'approved' && license?.spdx !== null) {
    errors.push('a pending root license must not claim an SPDX identifier');
  }
  const policy = governance.repositoryPolicy;
  if (!policy || !Number.isInteger(policy.requiredReviews) || policy.requiredReviews < 1) {
    errors.push('repositoryPolicy.requiredReviews must be an integer of at least 1');
  }
  for (const field of ['requiredStatusChecks', 'requireConversationResolution', 'secretPushProtection']) {
    if (policy?.[field] !== true) errors.push(`repositoryPolicy.${field} must be true`);
  }
  return errors;
}

export function validateRepositoryEvidence(evidence, governance, expectedCommitSha = '') {
  const errors = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return ['repository governance evidence is unavailable'];
  }
  if (evidence.schemaVersion !== 'omnikit.repository-governance-evidence.v1') {
    errors.push('repository governance evidence has an unsupported schemaVersion');
  }
  if (!nonEmptyString(evidence.generatedAt) || Number.isNaN(Date.parse(evidence.generatedAt))) {
    errors.push('repository governance evidence has an invalid generatedAt timestamp');
  }
  if (!/^[a-f0-9]{40}$/i.test(String(evidence.commitSha || ''))) {
    errors.push('repository governance evidence has an invalid commitSha');
  } else if (expectedCommitSha && evidence.commitSha !== expectedCommitSha) {
    errors.push('repository governance evidence is not bound to the release commit');
  }
  if (evidence.provider !== 'github') errors.push('repository governance evidence provider must be github');
  if (!nonEmptyString(evidence.repository) || !nonEmptyString(evidence.branch)) {
    errors.push('repository governance evidence must identify the repository and branch');
  }
  const actual = evidence.actualPolicy;
  const required = governance.repositoryPolicy;
  if (!actual || !Number.isInteger(actual.requiredReviews) || actual.requiredReviews < required.requiredReviews) {
    errors.push(`repository requires fewer than ${required.requiredReviews} approving review(s)`);
  }
  if (actual?.requiredStatusChecks !== true) errors.push('required status checks were not externally verified');
  if (actual?.requireConversationResolution !== true) errors.push('conversation resolution was not externally verified');
  if (actual?.secretPushProtection !== true) errors.push('secret push protection was not externally verified');
  if (!nonEmptyString(evidence.verifiedBy)) errors.push('repository governance evidence must identify the verifier');
  return errors;
}

export function verifyReleaseGovernance(projectRoot = defaultProjectRoot, options = {}) {
  const governancePath = resolve(projectRoot, options.governancePath || 'config/release-governance.json');
  const contractPath = resolve(projectRoot, 'contracts/release-governance.v1.schema.json');
  if (!existsSync(governancePath)) throw new Error('config/release-governance.json is missing');
  if (!existsSync(contractPath)) throw new Error('release governance contract is missing');
  const governance = readJson(governancePath);
  const contract = readJson(contractPath);
  const validateContract = new Ajv2020({ allErrors: true, strict: false }).compile(contract);
  const schemaValid = validateContract(governance);
  const schemaErrors = schemaValid ? [] : (validateContract.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'is invalid'}`);
  const configurationErrors = [...new Set([
    ...schemaErrors,
    ...validateGovernanceConfiguration(governance),
  ])];
  const decisionRecord = governance.rootLicense?.decisionRecord;
  const requiredFiles = [...requiredGovernanceFiles, decisionRecord].filter(Boolean);
  const missingFiles = requiredFiles.filter((file) => !existsSync(resolve(projectRoot, file)));
  const evidencePath = options.evidencePath ? resolve(projectRoot, options.evidencePath) : '';
  let repositoryEvidence = null;
  let evidenceErrors = ['repository governance evidence is unavailable'];
  if (evidencePath && existsSync(evidencePath)) {
    try {
      repositoryEvidence = readJson(evidencePath);
      evidenceErrors = validateRepositoryEvidence(repositoryEvidence, governance, options.expectedCommitSha || '');
    } catch (error) {
      evidenceErrors = [`repository governance evidence is invalid JSON: ${error instanceof Error ? error.message : error}`];
    }
  } else if (evidencePath) {
    evidenceErrors = [`repository governance evidence does not exist: ${options.evidencePath}`];
  }
  const decisionBlockers = [
    governance.releaseOwner ? '' : 'Named release owner',
    governance.supportOwner ? '' : 'Named support owner',
    governance.securityOwner ? '' : 'Named security owner',
    governance.supportResponseTarget ? '' : 'Approved support response target',
    governance.rootLicense?.status === 'approved' && governance.rootLicense?.spdx ? '' : 'Approved root repository license',
  ].filter(Boolean);
  const blockers = [
    ...configurationErrors.map((error) => `Configuration: ${error}`),
    ...missingFiles.map((file) => `Required governance file: ${file}`),
    ...decisionBlockers,
    ...evidenceErrors.map((error) => `External repository policy: ${error}`),
  ];
  return {
    schemaVersion: 'omnikit.release-governance-verification.v1',
    contractId: contract.$id,
    schemaValid,
    configurationValid: configurationErrors.length === 0,
    requiredFilesPresent: missingFiles.length === 0,
    decisionsComplete: decisionBlockers.length === 0,
    repositoryPolicyExternallyVerified: evidenceErrors.length === 0,
    releaseReady: blockers.length === 0,
    governance,
    requiredFiles,
    missingFiles,
    repositoryEvidence: repositoryEvidence ? {
      schemaVersion: repositoryEvidence.schemaVersion,
      generatedAt: repositoryEvidence.generatedAt,
      commitSha: repositoryEvidence.commitSha,
      provider: repositoryEvidence.provider,
      repository: repositoryEvidence.repository,
      branch: repositoryEvidence.branch,
      actualPolicy: repositoryEvidence.actualPolicy,
      verifiedBy: repositoryEvidence.verifiedBy,
    } : null,
    configurationErrors,
    evidenceErrors,
    externalBlockers: blockers,
  };
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyReleaseGovernance(defaultProjectRoot, {
      evidencePath: option('evidence'),
      expectedCommitSha: option('commit'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (process.argv.includes('--require-complete') && !result.releaseReady) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
