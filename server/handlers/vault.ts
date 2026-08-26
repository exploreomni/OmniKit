import { jsonHeaders } from '../security';
import { redactSensitiveText } from '../services/jobSanitizer';
import {
  changeVaultPassphrase,
  isVaultUnlocked,
  lockVault,
  purgeRetiredBiMigrationCredentials,
  resetVault,
  touchVaultSession,
  unlockVault,
  vaultStatus,
} from '../services/nativeVault';
import { clearJobs, resumeDestinationModelMutationReconciliation } from '../services/migrationJobs';
import {
  dashboardSafeCopyJobHasActiveOrUncertainEvidence,
  resumePendingDashboardSafeCopyJobs,
} from '../services/dashboardSafeCopyJobs';
import { prepareAndRunDashboardSafeCopyJob } from '../services/dashboardSafeCopyRuntime';
import { listJobs as listStoredJobs } from '../services/jobStore';
import { migrationJobHasUnresolvedDestinationModelMutation } from '../services/migrationScopeReservation';

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/vault\/?/, '');

    if (req.method === 'GET' && path === 'status') {
      return json(vaultStatus());
    }

    if (req.method === 'POST' && path === 'unlock') {
      const body = await bodyJson(req);
      const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
      unlockVault(passphrase);
      resumeDestinationModelMutationReconciliation();
      resumePendingDashboardSafeCopyJobs(prepareAndRunDashboardSafeCopyJob);
      return json({ ok: true, status: vaultStatus() });
    }

    if (req.method === 'POST' && path === 'lock') {
      lockVault();
      return json({ ok: true, status: vaultStatus() });
    }

    if (req.method === 'POST' && path === 'touch') {
      return json({ ok: true, status: touchVaultSession() });
    }

    if (req.method === 'POST' && path === 'change-passphrase') {
      if (!isVaultUnlocked()) return json({ error: 'vault locked' }, 423);
      const body = await bodyJson(req);
      const currentPassphrase = typeof body.currentPassphrase === 'string' ? body.currentPassphrase : '';
      const nextPassphrase = typeof body.nextPassphrase === 'string' ? body.nextPassphrase : '';
      changeVaultPassphrase(currentPassphrase, nextPassphrase);
      return json({ ok: true, status: vaultStatus() });
    }

    if (req.method === 'DELETE' && path === 'reset') {
      const storedJobs = listStoredJobs(Number.MAX_SAFE_INTEGER);
      if (
        storedJobs.some(dashboardSafeCopyJobHasActiveOrUncertainEvidence)
        || storedJobs.some(migrationJobHasUnresolvedDestinationModelMutation)
      ) {
        return json({
          error: 'The vault cannot be reset while a migration write is active or awaiting reconciliation.',
          code: 'MIGRATION_LEDGER_ACTIVE',
        }, 409);
      }
      resetVault();
      clearJobs();
      return json({ ok: true, status: vaultStatus() });
    }

    if (req.method === 'DELETE' && path === 'retired-bi-migration-credentials') {
      if (!isVaultUnlocked()) return json({ error: 'vault locked' }, 423);
      const removed = purgeRetiredBiMigrationCredentials();
      return json({ ok: true, removed, status: vaultStatus() });
    }

    return json({ error: `Unknown vault route: ${path}` }, 404);
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    return json({ error: error instanceof Error ? redactSensitiveText(error.message) : 'Vault operation failed.' }, statusCode);
  }
}
