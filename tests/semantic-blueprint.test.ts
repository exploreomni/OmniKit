import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_SEMANTIC_BLUEPRINT_DRAFT,
  createSemanticBlueprintApproval,
  formatSemanticBlueprintForAi,
  mergeSemanticBlueprintDraftForEditing,
  normalizeSemanticBlueprintDraft,
  semanticBlueprintApprovalIssues,
  semanticBlueprintActionOverridesAfterDraftPatch,
  semanticBlueprintExistingRelationshipContracts,
  semanticBlueprintFingerprint,
  semanticBlueprintIssues,
  semanticBlueprintModelYamlInventoryIssues,
  semanticBlueprintMutationFingerprint,
  semanticBlueprintPackageIssues,
  semanticBlueprintPlanBindings,
  semanticBlueprintPromptScope,
  semanticBlueprintQuestionLinesForEditing,
  semanticBlueprintViewOptions,
  type SemanticBlueprintDraft,
  type SemanticBlueprintMutationBoundary,
} from '../src/services/semanticBlueprint.ts';

test('guidance-only Blueprint edits preserve explicit actions while structural edits clear them', () => {
  const actions = {
    'view:subway/fact_orders.view': 'edit',
    'relationships:relationships': 'edit',
    'topic:subway_stats.topic': 'create',
  } as const;

  assert.deepEqual(semanticBlueprintActionOverridesAfterDraftPatch(actions, {
    relationshipGuidance: 'Use only the three approved relationship contracts.',
  }), actions);
  assert.deepEqual(semanticBlueprintActionOverridesAfterDraftPatch(actions, {
    securityGuidance: 'Preserve the existing access policy.',
  }), actions);
  assert.deepEqual(semanticBlueprintActionOverridesAfterDraftPatch(actions, {
    reviewedAndApproved: true,
  }), actions);
  assert.deepEqual(semanticBlueprintActionOverridesAfterDraftPatch(actions, {
    relationshipGuidance: 'Updated guidance.',
    reviewedAndApproved: false,
  }), actions);

  assert.deepEqual(semanticBlueprintActionOverridesAfterDraftPatch(actions, {
    primaryViewName: 'subway__fact_returns',
  }), {});
  assert.deepEqual(semanticBlueprintActionOverridesAfterDraftPatch(actions, {
    supportingViewNames: ['subway__dim_regions'],
    reviewedAndApproved: false,
  }), {});
  assert.deepEqual(semanticBlueprintActionOverridesAfterDraftPatch(actions, {
    relationshipDecisions: { subway__dim_locations: 'needs_review' },
  }), {});
});

test('blueprint editing preserves spaces until approval canonicalizes the draft', () => {
  const questions = semanticBlueprintQuestionLinesForEditing('Which stores are growing fastest? \nWhich products drive margin? ');
  assert.deepEqual(questions, [
    'Which stores are growing fastest? ',
    'Which products drive margin? ',
  ]);

  const editing = mergeSemanticBlueprintDraftForEditing(EMPTY_SEMANTIC_BLUEPRINT_DRAFT, {
    businessPurpose: 'Help regional leaders understand performance ',
    audience: 'Regional operators and finance leaders ',
    grain: 'One row per order line ',
    businessQuestions: questions,
    relationshipGuidance: 'Join by store id only ',
    securityGuidance: 'Preserve current access controls ',
  });
  assert.equal(editing.businessPurpose, 'Help regional leaders understand performance ');
  assert.equal(editing.audience, 'Regional operators and finance leaders ');
  assert.equal(editing.grain, 'One row per order line ');
  assert.deepEqual(editing.businessQuestions, questions);
  assert.equal(editing.relationshipGuidance, 'Join by store id only ');
  assert.equal(editing.securityGuidance, 'Preserve current access controls ');

  const approved = mergeSemanticBlueprintDraftForEditing(editing, { reviewedAndApproved: true });
  assert.equal(approved.businessPurpose, 'Help regional leaders understand performance');
  assert.equal(approved.audience, 'Regional operators and finance leaders');
  assert.equal(approved.grain, 'One row per order line');
  assert.deepEqual(approved.businessQuestions, [
    'Which stores are growing fastest?',
    'Which products drive margin?',
  ]);
});

test('discovers only valid authored relationship contracts for exact reuse', () => {
  const contracts = semanticBlueprintExistingRelationshipContracts({
    files: {
      relationships: [
        '- join_from_view: orders',
        '  join_to_view: locations',
        '  join_type: always_left',
        '  on_sql: ${orders.location_id} = ${locations.id}',
        '  relationship_type: many_to_one',
      ].join('\n'),
    },
  });
  assert.deepEqual(contracts, [{
    joinFromView: 'orders',
    joinToView: 'locations',
    joinType: 'always_left',
    onSql: '${orders.location_id} = ${locations.id}',
    relationshipType: 'many_to_one',
    reversible: false,
  }]);
  assert.deepEqual(semanticBlueprintExistingRelationshipContracts({
    files: { relationships: '- join_from_view: orders\n  join_to_view: locations\n' },
  }), []);
});

const modelYaml = {
  files: {
    'subway/fact_orders.view': 'schema: subway\ntable_name: fact_orders\ndimensions:\n  order_date:\n    type: date\n  order_id:\n    type: string\n',
    'subway/dim_locations.view': 'schema: subway\ntable_name: dim_locations\ndimensions:\n  location_id: {}\n  opened_at:\n    type: timestamp\n',
    'restaurant/whataburger_locations.view': 'schema: whataburger\ntable_name: dim_locations\ndimensions:\n  opened_date:\n    type: date\n',
  },
  viewNames: {
    'subway/fact_orders.view': 'subway__fact_orders',
    'subway/dim_locations.view': 'subway__dim_locations',
    'restaurant/whataburger_locations.view': 'whataburger__locations',
  },
};

const existingRelationshipContract = {
  joinFromView: 'subway__fact_orders',
  joinToView: 'subway__dim_locations',
  joinType: 'always_left' as const,
  onSql: '${subway__fact_orders.location_id} = ${subway__dim_locations.location_id}',
  relationshipType: 'many_to_one' as const,
  reversible: false,
};

const existingRelationshipsYaml = [
  '- join_from_view: subway__fact_orders',
  '  join_to_view: subway__dim_locations',
  '  join_type: always_left',
  '  on_sql: ${subway__fact_orders.location_id} = ${subway__dim_locations.location_id}',
  '  relationship_type: many_to_one',
  '  reversible: false',
].join('\n');

const approvedTopicYaml = [
  'base_view: subway__fact_orders',
  'default_filters:',
  '  subway__fact_orders.order_date: {}',
  '',
].join('\n');

const approvalModelYaml = {
  files: {
    model: 'default_row_limit: 500\n',
    relationships: existingRelationshipsYaml,
    ...modelYaml.files,
  },
  viewNames: modelYaml.viewNames,
  checksums: {
    model: 'model-v1',
    relationships: 'relationships-v1',
    'subway/fact_orders.view': 'fact-v1',
    'subway/dim_locations.view': 'locations-v1',
    'restaurant/whataburger_locations.view': 'unrelated-v1',
  },
};

const mutationBoundary: SemanticBlueprintMutationBoundary = {
  targetTopicFileName: 'subway_store_performance.topic',
  solutionPlanFingerprint: 'fnv1a64:1111111111111111',
  permissionContractFingerprint: 'permission-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  requestedArtifactFileNames: [
    'subway/dim_locations.view',
    'subway/fact_orders.view',
  ],
  excludedArtifactFileNames: ['restaurant/whataburger_locations.view'],
  relationshipIntent: 'required',
  permissionIntent: 'not_required',
  actionOverrides: {
    'view:subway/dim_locations.view': 'reuse',
    'view:subway/fact_orders.view': 'reuse',
  },
};

function approvedDraft(patch: Partial<SemanticBlueprintDraft> = {}): SemanticBlueprintDraft {
  return normalizeSemanticBlueprintDraft({
    ...EMPTY_SEMANTIC_BLUEPRINT_DRAFT,
    businessPurpose: 'Analyze Subway order and store performance.',
    audience: 'Regional operators',
    grain: 'One row per order line',
    businessQuestions: ['Which stores are growing fastest?'],
    focusedSchemaNames: ['subway'],
    primaryViewName: 'subway__fact_orders',
    supportingViewNames: ['subway__dim_locations'],
    relationshipDecisions: {
      subway__dim_locations: 'use_existing',
    },
    relationshipContracts: {
      subway__dim_locations: existingRelationshipContract,
    },
    excludedViewNames: ['whataburger__locations'],
    primaryDateField: 'subway__fact_orders.order_date',
    primaryDateNotRequired: false,
    relationshipGuidance: 'Join locations by location_id only.',
    securityGuidance: 'Preserve separately reviewed access controls.',
    reviewedAndApproved: true,
    ...patch,
  });
}

test('discovers schema and conservative fact/dimension hints from authored view YAML', () => {
  const options = semanticBlueprintViewOptions(modelYaml);
  assert.deepEqual(options.map((option) => ({
    viewName: option.viewName,
    schemaName: option.schemaName,
    roleHint: option.roleHint,
  })), [
    { viewName: 'subway__dim_locations', schemaName: 'subway', roleHint: 'dimension' },
    { viewName: 'subway__fact_orders', schemaName: 'subway', roleHint: 'fact' },
    { viewName: 'whataburger__locations', schemaName: 'whataburger', roleHint: 'dimension' },
  ]);
  assert.deepEqual(
    options.find((option) => option.viewName === 'subway__fact_orders')?.dateFieldNames,
    ['order_date'],
  );
  assert.deepEqual(
    options.find((option) => option.viewName === 'subway__dim_locations')?.dateTimeFields,
    [{
      viewName: 'subway__dim_locations',
      fieldName: 'opened_at',
      fieldReference: 'subway__dim_locations.opened_at',
      dataType: 'timestamp',
    }],
  );
});

test('accepts inherited views from a verified resolved inventory without treating them as authored mutations', () => {
  const authoredYaml = {
    files: {
      model: 'extends: base_model\n',
      'local/local_orders.view': 'schema: local\ntable_name: orders\n',
    },
    viewNames: {
      'local/local_orders.view': 'local__orders',
    },
  };
  const resolvedYaml = {
    files: {
      ...authoredYaml.files,
      'shared/customers.view': 'schema: shared\ntable_name: customers\ndimensions:\n  created_at:\n    type: timestamp\n',
    },
    viewNames: {
      ...authoredYaml.viewNames,
      'shared/customers.view': 'shared__customers',
    },
  };

  assert.deepEqual(semanticBlueprintModelYamlInventoryIssues(resolvedYaml, authoredYaml), []);
  const resolvedOptions = semanticBlueprintViewOptions(resolvedYaml);
  assert.deepEqual(resolvedOptions.map((option) => option.viewName), [
    'local__orders',
    'shared__customers',
  ]);

  const bindings = semanticBlueprintPlanBindings(approvedDraft({
    primaryViewName: 'shared__customers',
    supportingViewNames: ['local__orders'],
    relationshipDecisions: { local__orders: 'needs_review' },
    relationshipContracts: {},
    primaryDateField: 'shared__customers.created_at',
  }), resolvedOptions, {
    authoredFileNames: Object.keys(authoredYaml.files),
  });
  assert.deepEqual(bindings.requestedArtifactFileNames, ['local/local_orders.view']);
  assert.equal(
    Object.prototype.hasOwnProperty.call(bindings.actionOverrides, 'view:shared/customers.view'),
    false,
  );
});

test('rejects malformed or internally inconsistent resolved view inventories', () => {
  assert.match(
    semanticBlueprintModelYamlInventoryIssues({}, { files: {} }).join(' '),
    /did not return a resolved model file inventory/i,
  );
  assert.match(
    semanticBlueprintModelYamlInventoryIssues(
      { files: { model: 'name: example\n' }, viewNames: {} },
      modelYaml,
    ).join(' '),
    /omitted 3 authored views/i,
  );
});

test('requires an exact verified reachable date/time field or an explicit no-default-date decision', () => {
  const viewOptions = semanticBlueprintViewOptions(modelYaml);
  assert.match(semanticBlueprintIssues({
    draft: approvedDraft({ primaryDateField: '', primaryDateNotRequired: false }),
    viewOptions,
  }).join('\n'), /verified date\/time field or explicitly approve no default date/i);

  assert.match(semanticBlueprintIssues({
    draft: approvedDraft({ primaryDateField: 'subway__fact_orders.order_id' }),
    viewOptions,
  }).join('\n'), /not an exact verified date\/time field on an approved reachable view/i);

  assert.match(semanticBlueprintIssues({
    draft: approvedDraft({ primaryDateField: 'whataburger__locations.opened_date' }),
    viewOptions,
  }).join('\n'), /not an exact verified date\/time field on an approved reachable view/i);

  assert.deepEqual(semanticBlueprintIssues({
    draft: approvedDraft({ primaryDateField: 'subway__dim_locations.opened_at' }),
    viewOptions,
  }), []);

  const noDefaultDate = approvedDraft({
    primaryDateField: 'subway__fact_orders.order_date',
    primaryDateNotRequired: true,
  });
  assert.equal(noDefaultDate.primaryDateField, '');
  assert.deepEqual(semanticBlueprintIssues({ draft: noDefaultDate, viewOptions }), []);
});

test('requires user-authored intent, grain, question, primary view, relationship decisions, and approval', () => {
  const issues = semanticBlueprintIssues({
    draft: EMPTY_SEMANTIC_BLUEPRINT_DRAFT,
    viewOptions: semanticBlueprintViewOptions(modelYaml),
  });
  assert.ok(issues.some((issue) => /business outcome/i.test(issue)));
  assert.ok(issues.some((issue) => /one row or record/i.test(issue)));
  assert.ok(issues.some((issue) => /business question/i.test(issue)));
  assert.ok(issues.some((issue) => /primary data view/i.test(issue)));
  assert.ok(issues.some((issue) => /approve the semantic blueprint/i.test(issue)));

  const unresolvedRelationship = semanticBlueprintIssues({
    draft: approvedDraft({ relationshipDecisions: {} }),
    viewOptions: semanticBlueprintViewOptions(modelYaml),
  });
  assert.ok(unresolvedRelationship.some((issue) => /how supporting view.*should relate/i.test(issue)));

  const missingExistingContract = semanticBlueprintIssues({
    draft: approvedDraft({ relationshipContracts: {} }),
    viewOptions: semanticBlueprintViewOptions(modelYaml),
  });
  assert.ok(missingExistingContract.some((issue) => /exact authored relationship contract/i.test(issue)));
});

test('accepts a complete approved Subway blueprint and ignores legacy exclusion selections', () => {
  const draft = approvedDraft();
  assert.deepEqual(semanticBlueprintIssues({
    draft,
    viewOptions: semanticBlueprintViewOptions(modelYaml),
  }), []);
  assert.deepEqual(draft.supportingViewNames, ['subway__dim_locations']);
  assert.deepEqual(draft.excludedViewNames, []);
});

test('blocks stale views and approved views outside the selected schema focus', () => {
  const options = semanticBlueprintViewOptions(modelYaml);
  const stale = semanticBlueprintIssues({
    draft: approvedDraft({ primaryViewName: 'subway__missing' }),
    viewOptions: options,
  });
  assert.ok(stale.some((issue) => /no longer available/i.test(issue)));

  const wrongSchema = semanticBlueprintIssues({
    draft: approvedDraft({
      supportingViewNames: ['whataburger__locations'],
      excludedViewNames: [],
    }),
    viewOptions: options,
  });
  assert.ok(wrongSchema.some((issue) => /outside the selected schema focus/i.test(issue)));
});

test('normalization ignores saved explicit exclusions now that scope is include-only', () => {
  const draft = approvedDraft({
    excludedViewNames: ['subway__fact_orders', 'subway__dim_locations', 'whataburger__locations'],
  });
  assert.deepEqual(draft.excludedViewNames, []);
});

test('normalization removes relationship decisions for views outside the approved supporting scope', () => {
  const draft = approvedDraft({
    relationshipDecisions: {
      subway__dim_locations: 'create_reusable',
      whataburger__locations: 'create_reusable',
    },
  });
  assert.deepEqual(draft.relationshipDecisions, {
    subway__dim_locations: 'create_reusable',
  });
});

test('compiles approved views into deterministic include-only planner bindings', () => {
  const bindings = semanticBlueprintPlanBindings(
    approvedDraft(),
    semanticBlueprintViewOptions(modelYaml),
  );
  assert.deepEqual(bindings, {
    requestedArtifactFileNames: [
      'subway/dim_locations.view',
      'subway/fact_orders.view',
    ],
    excludedArtifactFileNames: ['restaurant/whataburger_locations.view'],
    actionOverrides: {
      'view:subway/dim_locations.view': 'reuse',
      'view:subway/fact_orders.view': 'reuse',
    },
  });
});

test('limits AI repair context to the approved blueprint files and view names', () => {
  assert.deepEqual(semanticBlueprintPromptScope(
    approvedDraft(),
    semanticBlueprintViewOptions(modelYaml),
  ), {
    readOnlyFileNames: [
      'model',
      'relationships',
      'subway/dim_locations.view',
      'subway/fact_orders.view',
    ],
    viewNames: ['subway__fact_orders', 'subway__dim_locations'],
  });
});

test('fingerprint is stable for list order but changes when user intent changes', () => {
  const first = approvedDraft({ businessQuestions: ['Question B', 'Question A'] });
  const reordered = approvedDraft({ businessQuestions: ['Question A', 'Question B'] });
  const changed = approvedDraft({ grain: 'One row per store day' });
  assert.equal(semanticBlueprintFingerprint(first), semanticBlueprintFingerprint(reordered));
  assert.notEqual(semanticBlueprintFingerprint(first), semanticBlueprintFingerprint(changed));
  assert.match(semanticBlueprintFingerprint(first), /^blueprint-sha256:[a-f0-9]{64}$/);
});

test('approval binds the blueprint to its exact governed source closure', () => {
  const draft = approvedDraft();
  const approval = createSemanticBlueprintApproval({
    draft,
    modelId: 'model-a',
    modelYaml: approvalModelYaml,
    mutationBoundary,
  });
  assert.deepEqual(semanticBlueprintApprovalIssues({
    approval,
    draft,
    modelId: 'model-a',
    modelYaml: approvalModelYaml,
    mutationBoundary,
  }), []);

  const hydratedChecksumsOnly = {
    ...approvalModelYaml,
    checksums: Object.fromEntries(
      Object.keys(approvalModelYaml.files).map((fileName) => [fileName, `hydrated-${fileName}`]),
    ),
  };
  assert.deepEqual(semanticBlueprintApprovalIssues({
    approval,
    draft,
    modelId: 'model-a',
    modelYaml: hydratedChecksumsOnly,
    mutationBoundary,
  }), [], 'optional checksum hydration must not invalidate unchanged reviewed YAML');

  const unrelatedViewChanged = {
    ...approvalModelYaml,
    files: {
      ...approvalModelYaml.files,
      'restaurant/whataburger_locations.view': 'schema: whataburger\ntable_name: changed_locations\n',
    },
    checksums: {
      ...approvalModelYaml.checksums,
      'restaurant/whataburger_locations.view': 'unrelated-v2',
    },
  };
  assert.deepEqual(semanticBlueprintApprovalIssues({
    approval,
    draft,
    modelId: 'model-a',
    modelYaml: unrelatedViewChanged,
    mutationBoundary,
  }), [], 'an unrelated out-of-scope view should not invalidate a focused approval');

  const approvedViewChanged = {
    ...approvalModelYaml,
    files: {
      ...approvalModelYaml.files,
      'subway/fact_orders.view': 'schema: subway\ntable_name: changed_fact_orders\n',
    },
    checksums: {
      ...approvalModelYaml.checksums,
      'subway/fact_orders.view': 'fact-v2',
    },
  };
  assert.match(semanticBlueprintApprovalIssues({
    approval,
    draft,
    modelId: 'model-a',
    modelYaml: approvedViewChanged,
    mutationBoundary,
  }).join('\n'), /model, relationship, view, or target topic context changed/i);

  const targetCreatedAfterApproval = {
    ...approvalModelYaml,
    files: {
      ...approvalModelYaml.files,
      'subway_store_performance.topic': approvedTopicYaml,
    },
    checksums: {
      ...approvalModelYaml.checksums,
      'subway_store_performance.topic': 'topic-v1',
    },
  };
  assert.match(semanticBlueprintApprovalIssues({
    approval,
    draft,
    modelId: 'model-a',
    modelYaml: targetCreatedAfterApproval,
    mutationBoundary,
  }).join('\n'), /model, relationship, view, or target topic context changed/i,
  'a concurrently created target topic must invalidate a new-topic approval');

  const nestedTargetCreatedAfterApproval = {
    ...approvalModelYaml,
    files: {
      ...approvalModelYaml.files,
      'domains/subway_store_performance.topic': approvedTopicYaml,
    },
    checksums: {
      ...approvalModelYaml.checksums,
      'domains/subway_store_performance.topic': 'nested-topic-v1',
    },
  };
  assert.match(semanticBlueprintApprovalIssues({
    approval,
    draft,
    modelId: 'model-a',
    modelYaml: nestedTargetCreatedAfterApproval,
    mutationBoundary,
  }).join('\n'), /model, relationship, view, or target topic context changed/i,
  'a same-leaf target topic created in any folder must invalidate approval');

  const existingTargetApproval = createSemanticBlueprintApproval({
    draft,
    modelId: 'model-a',
    modelYaml: targetCreatedAfterApproval,
    mutationBoundary,
  });
  const existingTargetChanged = {
    ...targetCreatedAfterApproval,
    files: {
      ...targetCreatedAfterApproval.files,
      'subway_store_performance.topic': approvedTopicYaml.replace(
        'base_view: subway__fact_orders',
        'base_view: subway__dim_locations',
      ),
    },
    checksums: {
      ...targetCreatedAfterApproval.checksums,
      'subway_store_performance.topic': 'topic-v2',
    },
  };
  assert.match(semanticBlueprintApprovalIssues({
    approval: existingTargetApproval,
    draft,
    modelId: 'model-a',
    modelYaml: existingTargetChanged,
    mutationBoundary,
  }).join('\n'), /model, relationship, view, or target topic context changed/i,
  'an edited existing target topic must invalidate approval');

  assert.match(semanticBlueprintApprovalIssues({
    approval,
    draft: approvedDraft({ grain: 'One row per store day' }),
    modelId: 'model-a',
    modelYaml: approvalModelYaml,
    mutationBoundary,
  }).join('\n'), /blueprint changed after approval/i);
});

test('approval binds the exact artifact, relationship, permission, and action plan', () => {
  const draft = approvedDraft();
  const approval = createSemanticBlueprintApproval({
    draft,
    modelId: 'model-a',
    modelYaml: approvalModelYaml,
    mutationBoundary,
  });
  assert.match(approval.mutationFingerprint, /^mutation-sha256:[a-f0-9]{64}$/);
  assert.equal(
    approval.mutationFingerprint,
    semanticBlueprintMutationFingerprint(mutationBoundary),
  );

  const changedBoundary: SemanticBlueprintMutationBoundary = {
    ...mutationBoundary,
    permissionIntent: 'required',
  };
  assert.match(semanticBlueprintApprovalIssues({
    approval,
    draft,
    modelId: 'model-a',
    modelYaml: approvalModelYaml,
    mutationBoundary: changedBoundary,
  }).join('\n'), /permission, or action plan changed/i);

  assert.match(semanticBlueprintApprovalIssues({
    approval,
    draft,
    modelId: 'model-a',
    modelYaml: approvalModelYaml,
    mutationBoundary: {
      ...mutationBoundary,
      targetTopicFileName: 'another_topic.topic',
    },
  }).join('\n'), /artifact, relationship, permission, or action plan changed/i);

  assert.match(semanticBlueprintApprovalIssues({
    approval,
    draft,
    modelId: 'model-a',
    modelYaml: approvalModelYaml,
    mutationBoundary: {
      ...mutationBoundary,
      permissionContractFingerprint: 'permission-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  }).join('\n'), /artifact, relationship, permission, or action plan changed/i);
});

test('security guidance cannot be approved while access changes are excluded', () => {
  const issues = semanticBlueprintIssues({
    draft: approvedDraft(),
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    relationshipIntent: 'required',
    permissionIntent: 'not_required',
  });
  assert.ok(issues.some((issue) => /security guidance.*no access changes/i.test(issue)));
});

test('relationship YAML drift invalidates a semantic blueprint approval', () => {
  const draft = approvedDraft();
  const approval = createSemanticBlueprintApproval({
    draft,
    modelId: 'model-a',
    modelYaml: approvalModelYaml,
    mutationBoundary,
  });
  const changedRelationships = {
    ...approvalModelYaml,
    files: {
      ...approvalModelYaml.files,
      relationships: approvalModelYaml.files.relationships.replace('many_to_one', 'many_to_many'),
    },
    checksums: {
      ...approvalModelYaml.checksums,
      relationships: 'relationships-v2',
    },
  };
  assert.match(semanticBlueprintApprovalIssues({
    approval,
    draft,
    modelId: 'model-a',
    modelYaml: changedRelationships,
    mutationBoundary,
  }).join('\n'), /model, relationship, view, or target topic context changed/i);
});

test('create-reusable requires and enforces one exact relationship contract', () => {
  const draft = approvedDraft({
    relationshipDecisions: {
      subway__dim_locations: 'create_reusable',
    },
    relationshipContracts: {
      subway__dim_locations: {
        joinFromView: 'subway__fact_orders',
        joinToView: 'subway__dim_locations',
        joinType: 'always_left',
        onSql: '${subway__fact_orders.location_id} = ${subway__dim_locations.location_id}',
        relationshipType: 'many_to_one',
        reversible: false,
      },
    },
  });
  assert.deepEqual(semanticBlueprintIssues({
    draft,
    viewOptions: semanticBlueprintViewOptions(modelYaml),
  }), []);

  const relationshipsYaml = [
    '- join_from_view: subway__fact_orders',
    '  join_to_view: subway__dim_locations',
    '  join_type: always_left',
    '  on_sql: ${subway__fact_orders.location_id} = ${subway__dim_locations.location_id}',
    '  relationship_type: many_to_one',
    '  reversible: false',
  ].join('\n');
  assert.deepEqual(semanticBlueprintPackageIssues({
    draft,
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files: [{
      fileName: 'subway_stats.topic',
      yaml: approvedTopicYaml,
    }, {
      fileName: 'relationships',
      yaml: relationshipsYaml,
    }],
    baselineRelationshipsYaml: '',
    relationshipIntent: 'required',
  }), []);

  assert.match(semanticBlueprintPackageIssues({
    draft,
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files: [{
      fileName: 'subway_stats.topic',
      yaml: approvedTopicYaml,
    }, {
      fileName: 'relationships',
      yaml: relationshipsYaml.replace('many_to_one', 'many_to_many'),
    }],
    baselineRelationshipsYaml: '',
    relationshipIntent: 'required',
  }).join('\n'), /exact approved create_reusable rows|exactly match an approved create_reusable relationship contract/i);
});

test('Blobby may propose one governed reusable relationship without user-authored join SQL', () => {
  const draft = approvedDraft({
    relationshipDecisions: {
      subway__dim_locations: 'propose_reusable',
    },
  });
  assert.deepEqual(semanticBlueprintIssues({
    draft,
    viewOptions: semanticBlueprintViewOptions(modelYaml),
  }), []);

  const files = [{
    fileName: 'subway_stats.topic',
    yaml: approvedTopicYaml,
  }, {
    fileName: 'relationships',
    yaml: [
      '- join_from_view: subway__fact_orders',
      '  join_to_view: subway__dim_locations',
      '  join_type: always_left',
      '  on_sql: ${subway__fact_orders.location_id} = ${subway__dim_locations.location_id}',
      '  relationship_type: many_to_one',
      '  reversible: false',
    ].join('\n'),
  }];
  assert.deepEqual(semanticBlueprintPackageIssues({
    draft,
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files,
    baselineRelationshipsYaml: '',
    relationshipIntent: 'required',
  }), []);
  assert.deepEqual(semanticBlueprintPackageIssues({
    draft,
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files: files.filter((file) => file.fileName === 'relationships'),
    baselineRelationshipsYaml: '',
    relationshipIntent: 'required',
    allowPartialPackage: true,
  }), []);
  assert.match(semanticBlueprintPackageIssues({
    draft,
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files: [{ fileName: 'relationships', yaml: '[]\n' }],
    baselineRelationshipsYaml: '',
    relationshipIntent: 'required',
    allowPartialPackage: true,
  }).join('\n'), /did not return a proposed reusable relationship/i);

  assert.match(semanticBlueprintPackageIssues({
    draft,
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files: files.filter((file) => file.fileName !== 'relationships'),
    baselineRelationshipsYaml: '',
    relationshipIntent: 'required',
  }).join('\n'), /did not return a proposed reusable relationship/i);

  assert.match(semanticBlueprintPackageIssues({
    draft,
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files: files.map((file) => file.fileName === 'relationships'
      ? { ...file, yaml: file.yaml.replace('  on_sql: ${subway__fact_orders.location_id} = ${subway__dim_locations.location_id}\n', '') }
      : file),
    baselineRelationshipsYaml: '',
    relationshipIntent: 'required',
  }).join('\n'), /must include non-empty on_sql/i);

  assert.match(formatSemanticBlueprintForAi(draft), /minimum complete reusable relationship graph/i);
});

test('a retained-branch proposed relationship remains a reviewed delta from immutable main', () => {
  const draft = approvedDraft({
    relationshipDecisions: {
      subway__dim_locations: 'propose_reusable',
    },
  });
  const retainedBranchRelationships = [
    '- join_from_view: subway__fact_orders',
    '  join_to_view: subway__dim_locations',
    '  join_type: always_left',
    '  on_sql: ${subway__fact_orders.location_id} = ${subway__dim_locations.location_id}',
    '  relationship_type: many_to_one',
    '  reversible: false',
  ].join('\n');
  const retainedBranchFiles = [{
    fileName: 'subway_stats.topic',
    yaml: approvedTopicYaml,
  }, {
    fileName: 'relationships',
    yaml: retainedBranchRelationships,
  }];

  assert.deepEqual(semanticBlueprintPackageIssues({
    draft,
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files: retainedBranchFiles,
    baselineRelationshipsYaml: '',
    relationshipIntent: 'required',
  }), []);
  assert.match(semanticBlueprintPackageIssues({
    draft,
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files: retainedBranchFiles,
    baselineRelationshipsYaml: retainedBranchRelationships,
    relationshipIntent: 'required',
  }).join('\n'), /did not return a proposed reusable relationship/i);
});

test('AI context labels the blueprint immutable without leaking excluded view names', () => {
  const context = formatSemanticBlueprintForAi(approvedDraft());
  assert.match(context, /User-approved semantic blueprint \(immutable boundary\)/);
  assert.match(context, /Primary\/base view: subway__fact_orders/);
  assert.match(context, /Supporting views: subway__dim_locations/);
  assert.match(context, /Relationship decisions: subway__dim_locations=use_existing/);
  assert.match(context, /Include-only view policy: 2 approved view/i);
  assert.doesNotMatch(context, /whataburger__locations/i);
  assert.match(context, /If the solution requires broader scope, return a recommendation for user approval/);
});

test('the same immutable package validator blocks generated, repaired, or manually edited scope expansion', () => {
  const files = [{
    fileName: 'subway_stats.topic',
    yaml: 'base_view: whataburger__locations\n',
  }];
  const issues = semanticBlueprintPackageIssues({
    draft: approvedDraft(),
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files,
  });
  assert.match(issues.join('\n'), /reviewed primary data view is "subway__fact_orders"/i);
  assert.match(issues.join('\n'), /outside the reviewed topic data scope/i);
});

test('package validation does not let a staged view authorize itself', () => {
  const input = {
    draft: approvedDraft(),
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files: [{
      fileName: 'unapproved/new_domain.view',
      yaml: 'schema: other\ntable_name: facts\n',
    }, {
      fileName: 'subway_stats.topic',
      yaml: approvedTopicYaml,
    }],
  };
  const issues = semanticBlueprintPackageIssues(input);
  assert.match(issues.join('\n'), /staged view outside the reviewed semantic blueprint/i);

  const filenameOnlyApproval = semanticBlueprintPackageIssues({
    ...input,
    approvedStagedViewFileNames: ['unapproved/new_domain.view'],
  });
  assert.match(filenameOnlyApproval.join('\n'), /has no immutable approved view identity/i);
  assert.match(filenameOnlyApproval.join('\n'), /staged view outside the reviewed semantic blueprint/i);
});

test('approved staged filenames remain bound to the approved internal name and table source', () => {
  const validate = (yaml: string) => semanticBlueprintPackageIssues({
    draft: approvedDraft(),
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files: [{
      fileName: 'subway/fact_orders.view',
      yaml,
    }, {
      fileName: 'subway_stats.topic',
      yaml: approvedTopicYaml,
    }],
    baselineRelationshipsYaml: existingRelationshipsYaml,
    approvedStagedViewFileNames: ['subway/fact_orders.view'],
    relationshipIntent: 'required',
  }).join('\n');

  assert.equal(validate(modelYaml.files['subway/fact_orders.view']), '');
  assert.match(
    validate(`name: subway__hijacked\n${modelYaml.files['subway/fact_orders.view']}`),
    /changes the approved internal view name/i,
  );
  assert.match(
    validate(modelYaml.files['subway/fact_orders.view'].replace('table_name: fact_orders', 'table_name: changed_orders')),
    /changes the approved table source contract/i,
  );
});

test('a complete package passes when the approved existing relationship is authored', () => {
  const issues = semanticBlueprintPackageIssues({
    draft: approvedDraft(),
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files: [{
      fileName: 'subway_stats.topic',
      yaml: approvedTopicYaml,
    }],
    baselineRelationshipsYaml: existingRelationshipsYaml,
    relationshipIntent: 'required',
  });
  assert.deepEqual(issues, []);
});

test('complete package validation requires one valid topic at the approved target path', () => {
  const baseInput = {
    draft: approvedDraft(),
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    baselineRelationshipsYaml: existingRelationshipsYaml,
    relationshipIntent: 'required' as const,
    approvedTargetTopicFileName: 'subway_stats.topic',
  };

  assert.match(semanticBlueprintPackageIssues({
    ...baseInput,
    files: [],
  }).join('\n'), /exactly one complete topic artifact/i);
  assert.deepEqual(semanticBlueprintPackageIssues({
    ...baseInput,
    files: [],
    allowPartialPackage: true,
  }), []);
  assert.match(semanticBlueprintPackageIssues({
    ...baseInput,
    files: [{ fileName: 'subway_stats.topic', yaml: 'base_view: [' }],
  }).join('\n'), /complete, valid YAML topic object/i);
  assert.match(semanticBlueprintPackageIssues({
    ...baseInput,
    files: [{ fileName: 'subway_stats.topic', yaml: 'label: Subway performance\n' }],
  }).join('\n'), /non-empty base_view/i);
  assert.match(semanticBlueprintPackageIssues({
    ...baseInput,
    files: [{ fileName: 'another_topic.topic', yaml: approvedTopicYaml }],
  }).join('\n'), /does not match the approved target topic/i);
  assert.deepEqual(semanticBlueprintPackageIssues({
    ...baseInput,
    approvedTargetTopicFileName: 'Store Analytics/subway_stats.topic',
    files: [{ fileName: 'Store Analytics/subway_stats.topic', yaml: approvedTopicYaml }],
  }), []);
  assert.match(semanticBlueprintPackageIssues({
    ...baseInput,
    approvedTargetTopicFileName: 'Store Analytics/subway_stats.topic',
    files: [{ fileName: 'Finance/subway_stats.topic', yaml: approvedTopicYaml }],
  }).join('\n'), /does not match the approved target topic/i);
  assert.match(semanticBlueprintPackageIssues({
    ...baseInput,
    files: [
      { fileName: 'subway_stats.topic', yaml: approvedTopicYaml },
      { fileName: 'another_topic.topic', yaml: approvedTopicYaml },
    ],
  }).join('\n'), /contains 2 topic artifacts/i);
});

test('package validation enforces the approved primary-date decision', () => {
  const validate = (draft: SemanticBlueprintDraft, fieldReference: string) => semanticBlueprintPackageIssues({
    draft,
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files: [{
      fileName: 'subway_stats.topic',
      yaml: `base_view: subway__fact_orders\ndefault_filters:\n  ${fieldReference}: {}\n`,
    }],
    baselineRelationshipsYaml: existingRelationshipsYaml,
    relationshipIntent: 'required',
  }).join('\n');

  assert.equal(validate(approvedDraft(), 'subway__fact_orders.order_date'), '');
  assert.match(
    validate(approvedDraft(), 'subway__dim_locations.opened_at'),
    /approved primary date/i,
  );
  assert.match(
    validate(approvedDraft({ primaryDateField: '', primaryDateNotRequired: true }), 'subway__fact_orders.order_date'),
    /explicitly selected No default date/i,
  );

  const validateTopicYaml = (yaml: string) => semanticBlueprintPackageIssues({
    draft: approvedDraft(),
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files: [{ fileName: 'subway_stats.topic', yaml }],
    baselineRelationshipsYaml: existingRelationshipsYaml,
    relationshipIntent: 'required',
  }).join('\n');
  assert.match(
    validateTopicYaml('base_view: subway__fact_orders\n'),
    /does not include the approved primary date/i,
  );
  assert.match(
    validateTopicYaml('base_view: subway__fact_orders\ndefault_filters:\n  subway__fact_orders.order_id: {}\n'),
    /does not include the approved primary date/i,
  );
});

test('use-existing binds the exact canonical authored relationship row', () => {
  const validate = (baselineRelationshipsYaml: string) => semanticBlueprintPackageIssues({
    draft: approvedDraft(),
    viewOptions: semanticBlueprintViewOptions(modelYaml),
    files: [{ fileName: 'subway_stats.topic', yaml: approvedTopicYaml }],
    baselineRelationshipsYaml,
    relationshipIntent: 'required',
  }).join('\n');

  assert.equal(validate(existingRelationshipsYaml), '');
  [
    existingRelationshipsYaml.replace('location_id} =', 'location_key} ='),
    existingRelationshipsYaml
      .replace('join_from_view: subway__fact_orders', 'join_from_view: subway__dim_locations')
      .replace('join_to_view: subway__dim_locations', 'join_to_view: subway__fact_orders'),
    existingRelationshipsYaml.replace('join_type: always_left', 'join_type: inner'),
    existingRelationshipsYaml.replace('relationship_type: many_to_one', 'relationship_type: many_to_many'),
    existingRelationshipsYaml.replace('reversible: false', 'reversible: true'),
  ].forEach((driftedYaml) => {
    assert.match(validate(driftedYaml), /missing 1 of 1 exact approved use_existing rows/i);
  });
});
