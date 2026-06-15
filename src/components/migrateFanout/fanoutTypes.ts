import type {
  InstanceDocument,
  InstanceFolder,
  InstanceModel,
  MigrationJob,
  MigrationPlan,
  MigrationTarget,
  SavedInstancePublic,
} from '@/services/opsConsole';

export const FANOUT_DRAFT_STORAGE_KEY = 'omnikit:fanoutDraft:v1';

export type FanoutStep = 0 | 1 | 2 | 3;

export interface TargetDraft {
  id: string;
  destinationInstanceId: string;
  targetModelId: string;
  targetModelName: string;
  targetFolderPath: string;
  targetFolderId: string;
  selectedActionIndexes: number[];
}

export interface TargetCatalog {
  models: InstanceModel[];
  folders: InstanceFolder[];
  loading: boolean;
  loaded: boolean;
  error: string;
}

export interface FanoutDraft {
  step: FanoutStep;
  sourceId: string;
  sourceModelId: string;
  sourceFolderId: string;
  sourceFolderPath: string;
  selectedDocumentIds: string[];
  targets: TargetDraft[];
  emptyFirst: boolean;
  replaceSameNamed: boolean;
  metadataOnly: boolean;
  refreshSchemaAfterImport: boolean;
}

export interface FanoutRuntimeState {
  instances: SavedInstancePublic[];
  documents: InstanceDocument[];
  plan: MigrationPlan | null;
  job: MigrationJob | null;
}

export interface DestinationProgress {
  destinationId: string;
  destinationLabel: string;
  targetIds: string[];
  total: number;
  done: number;
  failed: number;
  warning: number;
  skipped: number;
  running: number;
  status: 'pending' | 'running' | 'succeeded' | 'warning' | 'failed' | 'canceled';
  currentItem?: string;
}

export function targetDraftToMigrationTarget(
  target: TargetDraft,
  instances: SavedInstancePublic[],
): MigrationTarget {
  const destination = instances.find((instance) => instance.id === target.destinationInstanceId);
  return {
    id: target.id,
    destinationInstanceId: target.destinationInstanceId,
    destinationLabel: destination?.label,
    targetModelId: target.targetModelId,
    targetModelName: target.targetModelName,
    targetFolderId: target.targetFolderId || undefined,
    targetFolderPath: target.targetFolderPath || undefined,
  };
}
