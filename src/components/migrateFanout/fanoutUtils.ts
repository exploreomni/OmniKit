import type { MigrationJob, MigrationJobItem, MigrationPlan, MigrationPlanStep } from '@/services/opsConsole';
import type { DestinationProgress } from './fanoutTypes';

export function isTerminalJobStatus(status: string) {
  return status === 'succeeded' || status === 'failed' || status === 'partial' || status === 'canceled';
}

export function statusClass(status: string) {
  if (status === 'succeeded' || status === 'success') return 'bg-green-100 text-green-700';
  if (status === 'warning' || status === 'partial') return 'bg-yellow-100 text-yellow-800';
  if (status === 'failed') return 'bg-red-100 text-red-700';
  if (status === 'canceled') return 'bg-surface-secondary text-content-secondary';
  if (status === 'running') return 'bg-omni-50 text-omni-700';
  return 'bg-surface-secondary text-content-secondary';
}

export function completedItem(item: MigrationJobItem) {
  return item.status === 'succeeded' || item.status === 'warning' || item.status === 'failed' || item.status === 'skipped';
}

export function estimateDurationSeconds(plan: MigrationPlan | null): number {
  if (!plan) return 0;
  const uniqueExports = new Set(plan.steps.filter((step) => step.kind === 'export').map((step) => step.documentId).filter(Boolean));
  const byDestination = new Map<string, number>();
  for (const step of plan.steps) {
    if (step.kind === 'export') continue;
    byDestination.set(step.destinationId, (byDestination.get(step.destinationId) || 0) + 1);
  }
  const slowestDestinationItems = Math.max(0, ...byDestination.values());
  return Math.ceil((uniqueExports.size + slowestDestinationItems) * 1.2);
}

export function summarizePlanByTarget(plan: MigrationPlan | null) {
  if (!plan) return [];
  return plan.targets.map((target) => {
    const steps = plan.steps.filter((step) => (
      step.targetId ? step.targetId === target.id : step.destinationId === target.destinationInstanceId
    ));
    const warnings = steps.flatMap((step) => step.warnings || []);
    const deletes = steps.filter((step) => step.kind === 'delete').length;
    return {
      target,
      steps,
      warningCount: warnings.length,
      warnings,
      deleteCount: deletes,
      status: warnings.length > 0 ? 'warning' : 'ready',
    };
  });
}

export function summarizeJobByDestination(job: MigrationJob | null): DestinationProgress[] {
  if (!job) return [];
  const groups = new Map<string, MigrationJobItem[]>();
  for (const item of job.items) {
    if (item.kind === 'export') continue;
    const rows = groups.get(item.destinationId) || [];
    rows.push(item);
    groups.set(item.destinationId, rows);
  }
  return [...groups.entries()].map(([destinationId, items]) => {
    const done = items.filter(completedItem).length;
    const failed = items.filter((item) => item.status === 'failed').length;
    const warning = items.filter((item) => item.status === 'warning').length;
    const skipped = items.filter((item) => item.status === 'skipped').length;
    const running = items.filter((item) => item.status === 'running').length;
    const current = items.find((item) => item.status === 'running') || items.find((item) => item.status === 'pending');
    let status: DestinationProgress['status'] = 'pending';
    if (job.status === 'canceled') status = 'canceled';
    else if (running > 0) status = 'running';
    else if (done === items.length && failed === 0 && warning === 0) status = 'succeeded';
    else if (done === items.length && failed === 0 && warning > 0) status = 'warning';
    else if (failed > 0) status = 'failed';
    return {
      destinationId,
      destinationLabel: items[0]?.destinationLabel || destinationId,
      targetIds: [...new Set(items.map((item) => item.targetId).filter((item): item is string => Boolean(item)))],
      total: items.length,
      done,
      failed,
      warning,
      skipped,
      running,
      status,
      currentItem: current?.documentName || current?.documentId || current?.kind,
    };
  });
}

export function targetStepKey(step: MigrationPlanStep, index: number) {
  return `${step.targetId || step.destinationId}:${step.kind}:${step.documentId || 'cleanup'}:${index}`;
}
