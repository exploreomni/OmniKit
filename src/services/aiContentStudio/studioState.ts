import { emptyAIContentOneShotBrief } from './brief';
import type { AIContentMode, AIContentOneShotBrief, AIContentOneShotBriefField } from './types';

export interface AIContentStudioFormState {
  mode: AIContentMode;
  modelId: string;
  topicName: string;
  contentName: string;
  brief: AIContentOneShotBrief;
  approvedScope: string;
}

export type AIContentStudioFormAction =
  | { type: 'reset-for-connection' }
  | { type: 'change-mode'; mode: AIContentMode }
  | { type: 'change-model'; modelId: string }
  | { type: 'change-topic'; topicName: string }
  | { type: 'sync-topics'; availableTopics: string[] }
  | { type: 'set-review-scope'; modelId: string; topicName?: string }
  | { type: 'change-content-name'; contentName: string }
  | { type: 'change-brief-field'; field: AIContentOneShotBriefField; value: string }
  | { type: 'approve-scope'; scope: string }
  | { type: 'clear-approval' };

export function initialAIContentStudioForm(mode: AIContentMode): AIContentStudioFormState {
  return {
    mode,
    modelId: '',
    topicName: '',
    contentName: '',
    brief: emptyAIContentOneShotBrief(),
    approvedScope: '',
  };
}

function changed(state: AIContentStudioFormState, patch: Partial<AIContentStudioFormState>): AIContentStudioFormState {
  return { ...state, ...patch, approvedScope: '' };
}

export function aiContentStudioFormReducer(
  state: AIContentStudioFormState,
  action: AIContentStudioFormAction,
): AIContentStudioFormState {
  switch (action.type) {
    case 'reset-for-connection':
      return initialAIContentStudioForm(state.mode);
    case 'change-mode':
      return initialAIContentStudioForm(action.mode);
    case 'change-model':
      return changed(state, { modelId: action.modelId, topicName: '' });
    case 'change-topic':
      return changed(state, { topicName: action.topicName });
    case 'sync-topics':
      // A late inventory does not change a model-wide (no topic) approval.
      // Revoke approval only when an actual selected topic has disappeared.
      return !state.topicName || action.availableTopics.includes(state.topicName)
        ? state
        : changed(state, { topicName: '' });
    case 'set-review-scope':
      return changed(state, { modelId: action.modelId, topicName: action.topicName || '' });
    case 'change-content-name':
      return changed(state, { contentName: action.contentName });
    case 'change-brief-field':
      return changed(state, { brief: { ...state.brief, [action.field]: action.value } });
    case 'approve-scope':
      return { ...state, approvedScope: action.scope };
    case 'clear-approval':
      return state.approvedScope ? { ...state, approvedScope: '' } : state;
    default:
      return state;
  }
}
