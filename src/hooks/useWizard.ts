import { useReducer, useCallback } from 'react';
import type { WizardState, WizardAction, WizardStep } from '@/types';

const initialState: WizardState = {
  currentStep: 0,
  source: { baseUrl: '', apiKey: '', status: 'untested', errorMessage: '' },
  target: { baseUrl: '', apiKey: '', status: 'untested', errorMessage: '' },
  sameInstance: true,
  folders: [],
  documents: [],
  selectedDashboards: [],
  sourceModels: [],
  targetModels: [],
  modelMappings: {},
  targetFolder: '',
  dryRun: true,
  dryRunCompleted: false,
  migrationInProgress: false,
  migrationResults: [],
  migrationSummary: null,
  currentMigrationIndex: -1,
};

function resetPlanState(state: WizardState): WizardState {
  return {
    ...state,
    targetModels: [],
    modelMappings: {},
    dryRunCompleted: false,
    migrationResults: [],
    migrationSummary: null,
    currentMigrationIndex: -1,
  };
}

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'SET_STEP':
      return { ...state, currentStep: action.step };

    case 'UPDATE_SOURCE': {
      const source = { ...state.source, ...action.payload };
      if (state.sameInstance) {
        return resetPlanState({ ...state, source, target: { ...source } });
      }
      return resetPlanState({ ...state, source });
    }

    case 'UPDATE_TARGET':
      return resetPlanState({ ...state, target: { ...state.target, ...action.payload } });

    case 'SET_SAME_INSTANCE':
      if (action.value) {
        return resetPlanState({ ...state, sameInstance: true, target: { ...state.source }, targetFolder: '' });
      }
      return resetPlanState({
        ...state,
        sameInstance: false,
        target: { baseUrl: '', apiKey: '', status: 'untested', errorMessage: '' },
        targetFolder: '',
      });

    case 'SET_FOLDERS':
      return { ...state, folders: action.folders };

    case 'SET_DOCUMENTS':
      return { ...state, documents: action.documents };

    case 'SET_SELECTED_DASHBOARDS':
      return resetPlanState({ ...state, selectedDashboards: action.dashboards });

    case 'SET_SOURCE_MODELS':
      return { ...state, sourceModels: action.models };

    case 'SET_TARGET_MODELS':
      return { ...state, targetModels: action.models };

    case 'SET_MODEL_MAPPING':
      return {
        ...state,
        modelMappings: { ...state.modelMappings, [action.sourceId]: action.targetId },
        dryRunCompleted: false,
        migrationResults: [],
        migrationSummary: null,
      };

    case 'SET_ALL_MODEL_MAPPINGS':
      return { ...state, modelMappings: action.mappings, dryRunCompleted: false, migrationResults: [], migrationSummary: null };

    case 'SET_TARGET_FOLDER':
      return { ...state, targetFolder: action.folder, dryRunCompleted: false, migrationResults: [], migrationSummary: null };

    case 'SET_DRY_RUN':
      return { ...state, dryRun: action.value };

    case 'SET_DRY_RUN_COMPLETED':
      return { ...state, dryRunCompleted: action.value };

    case 'START_MIGRATION': {
      const uniqueTargets = [...new Set(Object.values(state.modelMappings).filter(Boolean))];
      const singleTarget = uniqueTargets.length === 1 ? uniqueTargets[0] : '';
      return {
        ...state,
        migrationInProgress: true,
        migrationResults: state.selectedDashboards.map(d => ({
          id: d.id,
          name: d.name,
          status: 'pending' as const,
          sourceModel: d.baseModelId,
          targetModel: (d.baseModelId && state.modelMappings[d.baseModelId])
            ? state.modelMappings[d.baseModelId]
            : singleTarget,
        })),
        migrationSummary: null,
        currentMigrationIndex: 0,
      };
    }

    case 'UPDATE_MIGRATION_PROGRESS':
      return {
        ...state,
        currentMigrationIndex: action.index,
        migrationResults: state.migrationResults.map((r, i) =>
          i === action.index ? { ...r, ...action.result } : r
        ),
      };

    case 'COMPLETE_MIGRATION':
      return {
        ...state,
        migrationInProgress: false,
        migrationSummary: action.summary,
        migrationResults: action.results,
      };

    case 'ENRICH_DOCUMENTS': {
      const applyEnrichment = (docs: typeof state.documents) =>
        docs.map((d) => {
          const result = action.enrichments[d.id];
          if (!result) return d;
          return {
            ...d,
            ...(result.baseModelId ? { baseModelId: result.baseModelId } : {}),
            ...(result.baseModelName ? { baseModelName: result.baseModelName } : {}),
            ...(result.topicNames ? { topicNames: result.topicNames } : {}),
            ...(result.connectionName ? { connectionName: result.connectionName } : {}),
            ...(result.connectionId ? { connectionId: result.connectionId } : {}),
            enrichmentError: result.enrichmentError,
          };
        });
      return {
        ...state,
        documents: applyEnrichment(state.documents),
        selectedDashboards: applyEnrichment(state.selectedDashboards),
      };
    }

    case 'RESET_ALL':
      return { ...initialState };

    default:
      return state;
  }
}

export function useWizard() {
  const [state, dispatch] = useReducer(wizardReducer, initialState);

  const goToStep = useCallback((step: WizardStep) => {
    dispatch({ type: 'SET_STEP', step });
  }, []);

  const nextStep = useCallback(() => {
    if (state.currentStep < 3) {
      dispatch({ type: 'SET_STEP', step: (state.currentStep + 1) as WizardStep });
    }
  }, [state.currentStep]);

  const prevStep = useCallback(() => {
    if (state.currentStep > 0) {
      dispatch({ type: 'SET_STEP', step: (state.currentStep - 1) as WizardStep });
    }
  }, [state.currentStep]);

  const resetAll = useCallback(() => {
    dispatch({ type: 'RESET_ALL' });
  }, []);

  return { state, dispatch, goToStep, nextStep, prevStep, resetAll };
}
