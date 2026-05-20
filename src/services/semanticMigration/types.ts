export type MigrationSourceTool = 'dbt' | 'looker' | 'power_bi' | 'tableau' | 'domo';

export type PlannedMigrationSourceTool = 'sigma';

export interface MigrationArtifact {
  id: string;
  sourceTool: MigrationSourceTool;
  name: string;
  kind: 'manifest' | 'yaml' | 'sql' | 'lookml' | 'dashboard' | 'json' | 'xml' | 'metadata' | 'text' | 'unknown';
  content: string;
  sizeBytes: number;
  parseWarnings: string[];
}

export interface MigrationField {
  name: string;
  type?: string;
  sql?: string;
  description?: string;
  sourceArtifact?: string;
}

export interface MigrationMeasure extends MigrationField {
  aggregateType?: string;
}

export interface MigrationView {
  name: string;
  description?: string;
  sourceArtifact?: string;
  fields: MigrationField[];
  measures: MigrationMeasure[];
  warnings: string[];
}

export interface MigrationRelationship {
  from: string;
  to: string;
  joinType?: string;
  relationshipType?: string;
  sql?: string;
  sourceArtifact?: string;
}

export interface MigrationExplore {
  name: string;
  baseView?: string;
  joins: MigrationRelationship[];
  fields: string[];
  filters: string[];
  sourceArtifact?: string;
}

export interface MigrationDashboardEvidence {
  name: string;
  fields: string[];
  filters: string[];
  sourceArtifact?: string;
}

export interface MigrationInventory {
  sourceTool: MigrationSourceTool;
  artifactCount: number;
  artifacts: MigrationArtifact[];
  views: MigrationView[];
  explores: MigrationExplore[];
  relationships: MigrationRelationship[];
  dashboards: MigrationDashboardEvidence[];
  metrics: MigrationMeasure[];
  warnings: string[];
  summary: string;
}

export type SemanticYamlFileName = 'model' | 'relationships' | `${string}.topic` | `${string}.view`;

export interface SemanticMigrationFile {
  id: string;
  fileName: SemanticYamlFileName;
  yaml: string;
  source: 'semantic-migration';
}

export interface SemanticMigrationPackage {
  files: SemanticMigrationFile[];
  rawMessage: string;
  warnings: string[];
}

export type MigrationRunStage =
  | 'idle'
  | 'parsing'
  | 'planning'
  | 'package'
  | 'preparing'
  | 'creating-branch'
  | 'saving'
  | 'validating'
  | 'ready'
  | 'failed';

export interface MigrationDiffLine {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
}

export interface MigrationFileDiff {
  fileName: string;
  lines: MigrationDiffLine[];
}
