import { parseDocument } from 'yaml';
import type { DashboardDeploymentPlan } from '../../shared/dashboardDeploymentPlan';
import { dashboardRepairSnapshotHash } from './dashboardRepairApproval';
import { assertDashboardTopicRelationInventory, readDashboardTopicRelationInventory, dashboardTopicViewMatches } from './dashboardTopicRelationInventory';

export interface ReviewedReconstructedTopic {
  sourceModelId: string; sourceTopicName: string; targetTopicName: string;
  sourceFileName: string; targetFileName: string; yaml: string; documentIds: string[];
}
export type ReviewedReconstructedTopics = Record<string, ReviewedReconstructedTopic[]>;

/** A new topic is usable only after the approved definition is read from the destination shared model. */
export async function readReviewedReconstructedTopics(plan: DashboardDeploymentPlan,
  sourceFiles: (modelId: string) => Promise<Record<string, string>>,
  targetFiles: (instanceId: string, modelId: string) => Promise<Record<string, string>>,
  workbookFiles: (modelId: string) => Promise<Record<string, string>>,
  relationInventory?: (instanceId: string, modelId: string) => Promise<unknown>): Promise<ReviewedReconstructedTopics> {
  const result: ReviewedReconstructedTopics = {};
  for (const receipt of plan.topicRepairReceipts || []) {
    const destination = plan.intent.destinations.find((row) => row.targetId === receipt.targetId);
    if (!destination || !receipt.jobId || !Object.keys(receipt.sourceHashes).length
      || Object.entries(receipt.sourceHashes).some(([id, hash]) => plan.sourceHashes[id] !== hash || !plan.intent.source.documentIds.includes(id))) continue;
    const source = await sourceFiles(receipt.sourceModelId);
    if (dashboardRepairSnapshotHash(source) !== receipt.sourceModelHash) continue;
    if (!receipt.sourceWorkbookHashes || !Object.keys(receipt.sourceWorkbookHashes).length) continue;
    let workbookChanged = false;
    for (const [id, hash] of Object.entries(receipt.sourceWorkbookHashes)) if (dashboardRepairSnapshotHash(await workbookFiles(id)) !== hash) workbookChanged = true;
    if (workbookChanged) continue;
    const filename = `${receipt.sourceTopicName}.topic`;
    if (Object.keys(source).some((file) => file.toLowerCase() === filename.toLowerCase()
      || file.split('/').pop()?.toLowerCase() === filename.toLowerCase())) continue;
    const files = await targetFiles(destination.instanceId, destination.modelId);
    const bindings = Object.entries(receipt.targetViewBindings || {});
    if (bindings.length) {
      if (!relationInventory) continue;
      try {
        const inventory = readDashboardTopicRelationInventory(await relationInventory(destination.instanceId, destination.modelId));
        if (!inventory.complete || bindings.some(([name, file]) => {
          if (inventory.observedNames.includes(name) && !Object.hasOwn(inventory.fingerprints, name)) return true;
          const current = dashboardTopicViewMatches(files, inventory.fileNames, name);
          return current.conflict || current.matches.length !== 1 || current.matches[0] !== file;
        })) continue;
      } catch { continue; }
    }
    const relations = receipt.relationEvidence;
    if (receipt.sourceRelationInventoryHash || (relations && (Object.keys(relations.source).length || Object.keys(relations.target).length))) {
      if (!relationInventory) continue;
      try {
        const sourceInventory = await relationInventory(plan.intent.source.instanceId, receipt.sourceModelId);
        if (receipt.sourceRelationInventoryHash && readDashboardTopicRelationInventory(sourceInventory).snapshotHash !== receipt.sourceRelationInventoryHash) continue;
        assertDashboardTopicRelationInventory(sourceInventory, relations?.source || {}, 'Source');
        if (Object.keys(relations?.target || {}).length) assertDashboardTopicRelationInventory(await relationInventory(destination.instanceId, destination.modelId), relations!.target, 'Destination');
      } catch { continue; } // Stale inherited dependencies cannot authorize dashboard binding.
    }
    const yaml = files[receipt.targetFileName];
    if (typeof yaml !== 'string') continue; // Branch staging is not publication.
    const parsed = parseDocument(yaml, { uniqueKeys: true, strict: true });
    if (parsed.errors.length || parsed.warnings.length || dashboardRepairSnapshotHash(parsed.toJS({ maxAliasCount: 0 })) !== receipt.topicHash) continue;
    (result[receipt.targetId] ||= []).push({ sourceModelId: receipt.sourceModelId, sourceTopicName: receipt.sourceTopicName,
      targetTopicName: receipt.targetTopicName, sourceFileName: filename, targetFileName: receipt.targetFileName,
      yaml, documentIds: Object.keys(receipt.sourceHashes) });
  }
  return result;
}
