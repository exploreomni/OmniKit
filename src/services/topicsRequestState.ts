export type TopicsInventoryResource = 'topics' | 'modelFiles';

export type TopicsInventoryResourceState = 'idle' | 'loading' | 'succeeded' | 'failed' | 'skipped';

export type TopicsInventoryRequestPhase = 'idle' | 'loading' | 'healthy' | 'failed';

export interface TopicsInventoryRequestState {
  scopeKey: string;
  phase: TopicsInventoryRequestPhase;
  topics: TopicsInventoryResourceState;
  modelFiles: TopicsInventoryResourceState;
}

export interface TopicsInventoryRequestToken {
  scopeKey: string;
  generation: number;
}

export type SemanticStudioOperationKind = 'analyze' | 'generate' | 'apply' | 'repair' | 'discard' | 'handoff';

export interface SemanticStudioOperationToken {
  sequence: number;
  kind: SemanticStudioOperationKind;
  connectionKey: string;
  modelId: string;
}

export interface SemanticStudioOperationCoordinator {
  begin: (
    kind: SemanticStudioOperationKind,
    connectionKey: string,
    modelId: string,
  ) => SemanticStudioOperationToken;
  invalidate: () => void;
  owns: (token: SemanticStudioOperationToken) => boolean;
  settle: (token: SemanticStudioOperationToken) => boolean;
}

export interface TopicInventoryRecord {
  name: string;
  label?: string;
  description?: string;
}

export const STUDIO_MODEL_KINDS = ['SHARED', 'SHARED_EXTENSION', 'BRANCH'] as const;
export type StudioModelKind = (typeof STUDIO_MODEL_KINDS)[number];

export interface StudioModelInventoryRecord {
  id: string;
  kind?: string;
}

export interface StudioModelConnectionRecord {
  id: string;
  name: string;
}

export interface StudioModelWithConnection extends StudioModelInventoryRecord {
  connectionId?: string;
  connectionName?: string;
}

export interface StudioModelInventoryEnvelope<T extends StudioModelInventoryRecord> {
  models: readonly T[];
  pageInfo: {
    hasNextPage: false;
    nextCursor?: null;
    pageSize: number;
    totalRecords: number;
  };
  pagesFetched: number;
  complete: true;
  loadedResults: number;
  totalResults: number;
}

const MAX_TOPIC_RECORDS = 1_000;
const MAX_TOPIC_NAME_LENGTH = 512;
const MAX_TOPIC_METADATA_LENGTH = 16_384;
const MAX_STUDIO_MODELS = 15_000;
const MAX_STUDIO_CONNECTIONS = 5_000;
const MAX_STUDIO_CONNECTION_TEXT_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidTopicInventory(): never {
  throw new Error('Topic inventory response was invalid.');
}

function invalidStudioModelInventory(): never {
  throw new Error('Studio model inventory response was invalid.');
}

function invalidVerifiedModelInventory(): never {
  throw new Error('Destination model inventory response was invalid.');
}

function invalidStudioConnectionInventory(): never {
  throw new Error('Studio connection inventory response was invalid.');
}

export function createSemanticStudioOperationCoordinator(): SemanticStudioOperationCoordinator {
  let sequence = 0;
  let current: SemanticStudioOperationToken | null = null;
  const owns = (token: SemanticStudioOperationToken) => (
    current?.sequence === token.sequence
    && current.kind === token.kind
    && current.connectionKey === token.connectionKey
    && current.modelId === token.modelId
  );
  return {
    begin(kind, connectionKey, modelId) {
      sequence += 1;
      current = { sequence, kind, connectionKey, modelId };
      return current;
    },
    invalidate() {
      sequence += 1;
      current = null;
    },
    owns,
    settle(token) {
      if (!owns(token)) return false;
      current = null;
      return true;
    },
  };
}

function verifiedStudioModelEnvelopeModels<T extends StudioModelInventoryRecord>(
  envelope: unknown,
  invalid: () => never,
): readonly T[] {
  if (
    !isRecord(envelope)
    || Object.prototype.hasOwnProperty.call(envelope, 'error')
    || Object.prototype.hasOwnProperty.call(envelope, 'errors')
    || Object.prototype.hasOwnProperty.call(envelope, 'reasonCode')
    || envelope.complete !== true
    || !Array.isArray(envelope.models)
    || envelope.models.length > MAX_STUDIO_MODELS
    || !Number.isSafeInteger(envelope.loadedResults)
    || Number(envelope.loadedResults) < 0
    || !Number.isSafeInteger(envelope.totalResults)
    || envelope.loadedResults !== envelope.totalResults
    || envelope.models.length !== envelope.loadedResults
    || !Number.isSafeInteger(envelope.pagesFetched)
    || Number(envelope.pagesFetched) < 1
    || Number(envelope.pagesFetched) > 50
    || !isRecord(envelope.pageInfo)
    || envelope.pageInfo.hasNextPage !== false
    || (envelope.pageInfo.nextCursor !== undefined && envelope.pageInfo.nextCursor !== null)
    || !Number.isSafeInteger(envelope.pageInfo.pageSize)
    || Number(envelope.pageInfo.pageSize) < 1
    || Number(envelope.pageInfo.pageSize) > 100
    || envelope.pageInfo.totalRecords !== envelope.totalResults
  ) invalid();

  return envelope.models as readonly T[];
}

async function loadVerifiedStudioModelInventory<
  T extends StudioModelInventoryRecord,
  Kind extends string,
>(
  kinds: readonly Kind[],
  loadKind: (kind: Kind) => Promise<unknown>,
  invalid: () => never,
): Promise<T[]> {
  const collections = await Promise.all(kinds.map(async (kind) => {
    const envelope = await loadKind(kind);
    return { kind, models: verifiedStudioModelEnvelopeModels<T>(envelope, invalid) };
  }));
  const seenIds = new Set<string>();
  const inventory: T[] = [];

  for (const { kind, models } of collections) {
    for (const model of models) {
      const candidate: unknown = model;
      if (
        !isRecord(candidate)
        || typeof candidate.id !== 'string'
        || candidate.id.length === 0
        || candidate.id !== candidate.id.trim()
        || candidate.kind !== kind
        || seenIds.has(candidate.id)
        || inventory.length >= MAX_STUDIO_MODELS
      ) invalid();
      seenIds.add(candidate.id);
      inventory.push(model);
    }
  }

  return inventory;
}

export async function loadStudioModelInventory<T extends StudioModelInventoryRecord>(
  loadKind: (kind: StudioModelKind) => Promise<unknown>,
): Promise<T[]> {
  return loadVerifiedStudioModelInventory(
    STUDIO_MODEL_KINDS,
    loadKind,
    invalidStudioModelInventory,
  );
}

export function parseVerifiedModelInventory<T extends StudioModelInventoryRecord>(
  envelope: unknown,
  allowedKinds: readonly string[],
): T[] {
  const models = verifiedStudioModelEnvelopeModels<T>(envelope, invalidVerifiedModelInventory);
  const allowedKindSet = new Set<string>(allowedKinds);
  const seenIds = new Set<string>();

  return models.map((model) => {
    const candidate: unknown = model;
    if (
      !isRecord(candidate)
      || typeof candidate.id !== 'string'
      || candidate.id.length === 0
      || candidate.id !== candidate.id.trim()
      || typeof candidate.kind !== 'string'
      || !allowedKindSet.has(candidate.kind)
      || seenIds.has(candidate.id)
    ) invalidVerifiedModelInventory();
    seenIds.add(candidate.id);
    return model;
  });
}

export function applyStudioConnectionNames<T extends StudioModelWithConnection>(
  models: readonly T[],
  connections: readonly StudioModelConnectionRecord[],
): Array<Omit<T, 'connectionName'> & { connectionName?: string }> {
  const connectionNames = new Map(connections.map((connection) => [connection.id, connection.name]));
  return models.map((model) => {
    const verifiedModel = { ...model };
    delete verifiedModel.connectionName;
    const connectionName = model.connectionId ? connectionNames.get(model.connectionId) : undefined;
    return connectionName
      ? { ...verifiedModel, connectionName }
      : verifiedModel;
  });
}

export function parseStudioConnectionNamesResponse(value: unknown): StudioModelConnectionRecord[] {
  if (
    !isRecord(value)
    || Object.prototype.hasOwnProperty.call(value, 'error')
    || Object.prototype.hasOwnProperty.call(value, 'errors')
    || !Array.isArray(value.connections)
    || value.connections.length > MAX_STUDIO_CONNECTIONS
  ) invalidStudioConnectionInventory();

  const seenIds = new Set<string>();
  return value.connections.map((connection) => {
    if (!isRecord(connection)) invalidStudioConnectionInventory();
    const { id, name } = connection;
    if (
      typeof id !== 'string'
      || id.length === 0
      || id !== id.trim()
      || id.length > MAX_STUDIO_CONNECTION_TEXT_LENGTH
      || typeof name !== 'string'
      || name.length === 0
      || name !== name.trim()
      || name.length > MAX_STUDIO_CONNECTION_TEXT_LENGTH
      || seenIds.has(id)
    ) invalidStudioConnectionInventory();
    seenIds.add(id);
    return { id, name };
  });
}

export function parseTopicInventoryResponse(value: unknown): TopicInventoryRecord[] {
  if (
    !isRecord(value)
    || Object.prototype.hasOwnProperty.call(value, 'error')
    || Object.prototype.hasOwnProperty.call(value, 'errors')
    || !Object.prototype.hasOwnProperty.call(value, 'topics')
    || !Array.isArray(value.topics)
    || value.topics.length > MAX_TOPIC_RECORDS
  ) invalidTopicInventory();

  const names = new Set<string>();
  return value.topics.map((entry) => {
    if (!isRecord(entry)) invalidTopicInventory();
    const name = entry.name;
    if (
      typeof name !== 'string'
      || name.length === 0
      || name !== name.trim()
      || name.length > MAX_TOPIC_NAME_LENGTH
      || names.has(name)
    ) invalidTopicInventory();
    names.add(name);

    const parsed: TopicInventoryRecord = { name };
    for (const key of ['label', 'description'] as const) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
      const metadata = entry[key];
      if (
        typeof metadata !== 'string'
        || metadata.length === 0
        || metadata !== metadata.trim()
        || metadata.length > MAX_TOPIC_METADATA_LENGTH
      ) invalidTopicInventory();
      parsed[key] = metadata;
    }
    return parsed;
  });
}

export interface TopicsInventoryRequestCoordinator {
  begin: (
    scopeKey: string,
    resources: readonly TopicsInventoryResource[],
  ) => TopicsInventoryRequestToken | null;
  clear: () => void;
  isCurrent: (token: TopicsInventoryRequestToken) => boolean;
  settle: (
    token: TopicsInventoryRequestToken,
    resource: TopicsInventoryResource,
    outcome: 'succeeded' | 'failed',
  ) => boolean;
  snapshot: () => TopicsInventoryRequestState;
}

const IDLE_STATE: TopicsInventoryRequestState = {
  scopeKey: '',
  phase: 'idle',
  topics: 'idle',
  modelFiles: 'idle',
};

function copyState(state: TopicsInventoryRequestState): TopicsInventoryRequestState {
  return { ...state };
}

export function createTopicsInventoryRequestCoordinator(
  onChange: (state: TopicsInventoryRequestState) => void = () => undefined,
): TopicsInventoryRequestCoordinator {
  let generation = 0;
  let state = copyState(IDLE_STATE);

  const emit = () => onChange(copyState(state));
  const clear = () => {
    generation += 1;
    state = copyState(IDLE_STATE);
    emit();
  };

  const isCurrent = (token: TopicsInventoryRequestToken) => (
    token.generation === generation
    && token.scopeKey === state.scopeKey
    && state.phase !== 'idle'
  );

  return {
    begin(scopeKey, resources) {
      if (!scopeKey) {
        clear();
        return null;
      }

      if (state.scopeKey === scopeKey && (state.phase === 'loading' || state.phase === 'healthy')) {
        return null;
      }

      const requested = new Set(resources);
      generation += 1;
      state = {
        scopeKey,
        phase: 'loading',
        topics: requested.has('topics') ? 'loading' : 'skipped',
        modelFiles: requested.has('modelFiles') ? 'loading' : 'skipped',
      };
      emit();
      return { scopeKey, generation };
    },

    clear,

    isCurrent,

    settle(token, resource, outcome) {
      if (!isCurrent(token) || state[resource] !== 'loading') return false;

      state = { ...state, [resource]: outcome };
      const resourceStates = [state.topics, state.modelFiles];
      state.phase = resourceStates.includes('loading')
        ? 'loading'
        : resourceStates.includes('failed')
          ? 'failed'
          : 'healthy';
      emit();
      return true;
    },

    snapshot() {
      return copyState(state);
    },
  };
}
