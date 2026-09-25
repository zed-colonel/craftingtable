// Reviewed application-owned v0.3 source schema. Never compile an uploaded schema.
// Repository aliases, baseline identities and counts are generic; semantics remain closed.
export const concurrencySourceSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:exo-stack:cross-stack-concurrency-map:0.3.0',
  title: 'Cross-stack concurrency scheduling sidecar \u2014 draft 0.3.0',
  type: 'object',
  additionalProperties: false,
  properties: {
    $schema: {
      const: 'cross-stack-concurrency-map.schema.json',
    },
    document: {
      type: 'string',
      minLength: 1,
      maxLength: 16000,
    },
    kind: {
      const: 'cross_stack_concurrency_map',
    },
    schema_version: {
      const: '0.3.0',
    },
    map_id: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
    },
    revision: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
    },
    status: {
      const: 'draft',
    },
    created_date: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      maxLength: 16000,
    },
    automatic_activation: {
      const: false,
    },
    source_files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          original_path: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          snapshot_path: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          sha256: {
            type: 'string',
            pattern: '^[a-f0-9]{64}$',
            maxLength: 16000,
          },
          format: {
            enum: ['markdown', 'yaml', 'json'],
          },
          role: {
            const: 'source_only_not_an_importable_plan',
          },
          repository: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
        },
        required: [
          'id',
          'original_path',
          'snapshot_path',
          'sha256',
          'format',
          'role',
          'repository',
        ],
      },
      minItems: 1,
      maxItems: 2000,
    },
    repositories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          repository: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          contract: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          planning_profile: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          target_branch: {
            anyOf: [
              {
                type: 'string',
                minLength: 1,
                maxLength: 16000,
              },
              {
                type: 'null',
              },
            ],
          },
          source_baseline_commit: {
            anyOf: [
              {
                type: 'string',
                pattern: '^[a-f0-9]{40}$',
                maxLength: 16000,
              },
              {
                type: 'null',
              },
            ],
          },
          source_plan: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          source_work_breakdown: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          source_stack_label: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          merge_lock: {
            anyOf: [
              {
                type: 'string',
                minLength: 1,
                maxLength: 16000,
              },
              {
                type: 'null',
              },
            ],
          },
          runtime_revision_status: {
            enum: ['unbound', 'source-archive-pinned'],
          },
          artifact_revision: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          supplement_sources: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            minItems: 0,
            maxItems: 2000,
          },
          role: {
            enum: ['implemented_upstream', 'planned_application'],
          },
        },
        required: [
          'id',
          'repository',
          'contract',
          'planning_profile',
          'target_branch',
          'source_baseline_commit',
          'source_plan',
          'source_work_breakdown',
          'source_stack_label',
          'merge_lock',
          'runtime_revision_status',
          'artifact_revision',
          'supplement_sources',
          'role',
        ],
      },
      minItems: 1,
      maxItems: 2000,
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            pattern: '^[A-Z][A-Z0-9-]+$',
            maxLength: 16000,
          },
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          proposed_resolution: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          source_notes: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            minItems: 1,
            maxItems: 2000,
          },
          status: {
            const: 'proposed_requires_approval',
          },
        },
        required: ['id', 'title', 'proposed_resolution', 'source_notes', 'status'],
      },
      minItems: 1,
      maxItems: 2000,
    },
    semantics: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requirement_operator: {
          const: 'all_of',
        },
        missing_or_stale_evidence: {
          const: 'blocked',
        },
        parent_acceptance: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
        slice_lifecycle: {
          const: ['started', 'merged', 'verified'],
        },
        merge_inherits_start_requirements: {
          const: true,
        },
        verification_inherits_merge_requirements: {
          const: true,
        },
        start_does_not_authorize_external_effects: {
          const: true,
        },
        checkpoint_prerequisites_do_not_auto_pass_checkpoint: {
          const: true,
        },
        planning_order_is_not_a_dependency: {
          const: true,
        },
        source_critical_path_arrays_are_not_executable_edges: {
          const: true,
        },
        historical_evidence_is_immutable: {
          const: true,
        },
        validity_is_scoped_to_active_pin_bindings: {
          const: true,
        },
        runtime_state_is_separate_from_definition: {
          const: true,
        },
        generation_changed_midflight: {
          const: 'revalidate_before_merge_verify_or_accept',
        },
        unknown_references: {
          const: 'reject_entire_import',
        },
        dependency_cycle: {
          const: 'reject_entire_import',
        },
        unsupported_required_semantics: {
          const: 'reject_entire_import',
        },
        partial_runtime_slices_require_explicit_scope: {
          const: true,
        },
        profile_milestones_do_not_accept_parents: {
          const: true,
        },
        source_case_owners_are_not_dependencies: {
          const: true,
        },
        resource_availability_is_not_evidence: {
          const: true,
        },
        source_hashes_are_not_runtime_evidence: {
          const: true,
        },
        partial_core_is_not_full_upstream_gate: {
          const: true,
        },
        implemented_upstream_is_not_runnable: {
          const: true,
        },
        baseline_acceptance_is_not_publication: {
          const: true,
        },
        baseline_case_receipts_required: {
          const: true,
        },
      },
      required: [
        'requirement_operator',
        'missing_or_stale_evidence',
        'parent_acceptance',
        'slice_lifecycle',
        'merge_inherits_start_requirements',
        'verification_inherits_merge_requirements',
        'start_does_not_authorize_external_effects',
        'checkpoint_prerequisites_do_not_auto_pass_checkpoint',
        'planning_order_is_not_a_dependency',
        'source_critical_path_arrays_are_not_executable_edges',
        'historical_evidence_is_immutable',
        'validity_is_scoped_to_active_pin_bindings',
        'runtime_state_is_separate_from_definition',
        'generation_changed_midflight',
        'unknown_references',
        'dependency_cycle',
        'unsupported_required_semantics',
        'partial_runtime_slices_require_explicit_scope',
        'profile_milestones_do_not_accept_parents',
        'source_case_owners_are_not_dependencies',
        'resource_availability_is_not_evidence',
        'source_hashes_are_not_runtime_evidence',
        'partial_core_is_not_full_upstream_gate',
        'implemented_upstream_is_not_runnable',
        'baseline_acceptance_is_not_publication',
        'baseline_case_receipts_required',
      ],
    },
    evidence_profiles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          required_evidence: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            minItems: 1,
            maxItems: 2000,
          },
          reviewer_roles: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            minItems: 1,
            maxItems: 2000,
          },
          independence_required: {
            const: true,
          },
        },
        required: ['id', 'required_evidence', 'reviewer_roles', 'independence_required'],
      },
      minItems: 1,
      maxItems: 2000,
    },
    scheduling_policy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          const: 'eligibility_not_a_calendar',
        },
        no_duration_or_speedup_estimates: {
          const: true,
        },
        agent_capacity: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
        resource_reservations: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
        hold_merge_lock_while_waiting_for_checkpoint: {
          const: false,
        },
        recheck_before_merge: {
          const: true,
        },
        required_execution_isolation: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
        priority_hint: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
        feedback_is_not_dependency: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
        suggested_focus_target: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
        target_selection: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
        resource_profile_binding: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
      },
      required: [
        'mode',
        'no_duration_or_speedup_estimates',
        'agent_capacity',
        'resource_reservations',
        'hold_merge_lock_while_waiting_for_checkpoint',
        'recheck_before_merge',
        'required_execution_isolation',
        'priority_hint',
        'feedback_is_not_dependency',
        'suggested_focus_target',
        'target_selection',
        'resource_profile_binding',
      ],
    },
    resource_locks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          repository: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          capacity: {
            const: 1,
          },
          stage: {
            const: 'merge',
          },
          scope: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
        },
        required: ['id', 'repository', 'capacity', 'stage', 'scope'],
      },
      minItems: 2,
      maxItems: 2000,
    },
    checkpoints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            pattern: '^[A-Z][A-Z0-9-]+$',
            maxLength: 16000,
          },
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          kind: {
            enum: [
              'plan_approval',
              'architecture_decision',
              'contract',
              'release_candidate',
              'release',
              'integration_evidence',
              'semantic_review',
              'profile',
              'partial_milestone',
              'baseline_acceptance',
            ],
          },
          owner: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          requires: {
            type: 'array',
            items: {
              $ref: '#/$defs/requirement',
            },
            minItems: 0,
            uniqueItems: true,
            maxItems: 2000,
          },
          evidence_profile: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          pass_criteria: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            minItems: 1,
            maxItems: 2000,
          },
          source_refs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source_id: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 16000,
                },
                section: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 16000,
                },
                start_line: {
                  type: 'integer',
                  minimum: 1,
                },
                end_line: {
                  type: 'integer',
                  minimum: 1,
                },
              },
              required: ['source_id', 'section'],
            },
            minItems: 0,
            maxItems: 2000,
          },
          status_on_import: {
            const: 'unresolved',
          },
          invalidation: {
            const: 'active-pin-or-evidence-change',
          },
          decision_refs: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            minItems: 0,
            maxItems: 2000,
          },
          evidence_owners: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            minItems: 1,
            maxItems: 2000,
          },
          historical_producer_work_items: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            uniqueItems: true,
            maxItems: 2000,
          },
        },
        required: [
          'id',
          'title',
          'kind',
          'owner',
          'requires',
          'evidence_profile',
          'pass_criteria',
          'source_refs',
          'status_on_import',
          'invalidation',
          'decision_refs',
        ],
      },
      minItems: 1,
      maxItems: 2000,
    },
    deferred_decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            pattern: '^[A-Z][A-Z0-9-]+$',
            maxLength: 16000,
          },
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          source_due: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          reason: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
        },
        required: ['id', 'title', 'source_due', 'reason'],
      },
      minItems: 0,
      maxItems: 2000,
    },
    work_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            pattern: '^[a-z][a-z0-9_-]*/[A-Z][A-Z0-9_-]*$',
            maxLength: 16000,
          },
          repository: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          source_item_id: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          planning_order: {
            type: 'integer',
            minimum: 1,
          },
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          source_record_sha256: {
            type: 'string',
            pattern: '^[a-f0-9]{64}$',
            maxLength: 16000,
          },
          source_maturity: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          depends_on: {
            type: 'array',
            items: {
              type: 'string',
              pattern: '^[a-z][a-z0-9_-]*/[A-Z][A-Z0-9_-]*$',
              maxLength: 16000,
            },
            minItems: 0,
            uniqueItems: true,
            maxItems: 2000,
          },
          primary_areas: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            minItems: 1,
            maxItems: 2000,
          },
          risk: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          source_exit_gate: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          source_test_reference: {
            type: 'object',
            additionalProperties: false,
            properties: {
              source_id: {
                type: 'string',
                minLength: 1,
                maxLength: 16000,
              },
              section: {
                type: 'string',
                minLength: 1,
                maxLength: 16000,
              },
              start_line: {
                type: 'integer',
                minimum: 1,
              },
              end_line: {
                type: 'integer',
                minimum: 1,
              },
            },
            required: ['source_id', 'section', 'start_line', 'end_line'],
          },
          required_slices: {
            type: 'array',
            items: {
              type: 'string',
              pattern: '^[a-z][a-z0-9_-]*/[A-Z][A-Z0-9_-]*/[a-z][a-z0-9-]*$',
              maxLength: 16000,
            },
            minItems: 1,
            uniqueItems: true,
            maxItems: 2000,
          },
          acceptance_requires: {
            type: 'array',
            items: {
              $ref: '#/$defs/requirement',
            },
            minItems: 0,
            uniqueItems: true,
            maxItems: 2000,
          },
          acceptance_evidence_profile: {
            const: 'work-item-exit',
          },
          source_profile_case_ids: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            uniqueItems: true,
            maxItems: 2000,
          },
          profile_evidence_slices: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            uniqueItems: true,
            maxItems: 2000,
          },
          aq_baseline_case_ids: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            uniqueItems: true,
            maxItems: 2000,
          },
        },
        required: [
          'id',
          'repository',
          'source_item_id',
          'planning_order',
          'title',
          'source_record_sha256',
          'source_maturity',
          'depends_on',
          'primary_areas',
          'risk',
          'source_exit_gate',
          'source_test_reference',
          'required_slices',
          'acceptance_requires',
          'acceptance_evidence_profile',
          'source_profile_case_ids',
          'profile_evidence_slices',
          'aq_baseline_case_ids',
        ],
      },
      minItems: 1,
      maxItems: 2000,
    },
    slices: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            pattern: '^[a-z][a-z0-9_-]*/[A-Z][A-Z0-9_-]*/[a-z][a-z0-9-]*$',
            maxLength: 16000,
          },
          work_item: {
            type: 'string',
            pattern: '^[a-z][a-z0-9_-]*/[A-Z][A-Z0-9_-]*$',
            maxLength: 16000,
          },
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          mode: {
            enum: [
              'domain',
              'implementation',
              'integration',
              'conformance',
              'release',
              'release_readiness',
            ],
          },
          scope: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          excludes: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            minItems: 1,
            maxItems: 2000,
          },
          start_requires: {
            type: 'array',
            items: {
              $ref: '#/$defs/requirement',
            },
            minItems: 0,
            uniqueItems: true,
            maxItems: 2000,
          },
          merge_requires: {
            type: 'array',
            items: {
              $ref: '#/$defs/requirement',
            },
            minItems: 0,
            uniqueItems: true,
            maxItems: 2000,
          },
          verify_requires: {
            type: 'array',
            items: {
              $ref: '#/$defs/requirement',
            },
            minItems: 0,
            uniqueItems: true,
            maxItems: 2000,
          },
          evidence_profile: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          merge_lock: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          workspace_policy: {
            const: 'isolated-worktree-and-test-state',
          },
          early_start_exception: {
            type: 'boolean',
          },
          source_refs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source_id: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 16000,
                },
                section: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 16000,
                },
                start_line: {
                  type: 'integer',
                  minimum: 1,
                },
                end_line: {
                  type: 'integer',
                  minimum: 1,
                },
              },
              required: ['source_id', 'section'],
            },
            minItems: 1,
            maxItems: 2000,
          },
          decision_refs: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            minItems: 0,
            maxItems: 2000,
          },
          grants_effect_authority: {
            const: false,
          },
          partial_scope: {
            enum: ['full', 'domain', 'embedded-proof', 'supervisor-proof'],
          },
          resources_by_phase: {
            type: 'object',
            additionalProperties: false,
            properties: {
              start: {
                type: 'array',
                items: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 16000,
                },
                minItems: 1,
                maxItems: 2000,
              },
              merge: {
                type: 'array',
                items: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 16000,
                },
                minItems: 1,
                maxItems: 2000,
              },
              verify: {
                type: 'array',
                items: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 16000,
                },
                minItems: 1,
                maxItems: 2000,
              },
            },
            required: ['start', 'merge', 'verify'],
          },
          planning_target_class: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          aq_baseline_case_ids: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            uniqueItems: true,
            maxItems: 2000,
          },
        },
        required: [
          'id',
          'work_item',
          'title',
          'mode',
          'scope',
          'excludes',
          'start_requires',
          'merge_requires',
          'verify_requires',
          'evidence_profile',
          'merge_lock',
          'workspace_policy',
          'early_start_exception',
          'source_refs',
          'decision_refs',
          'grants_effect_authority',
          'partial_scope',
          'resources_by_phase',
          'planning_target_class',
          'aq_baseline_case_ids',
        ],
      },
      minItems: 1,
      maxItems: 2000,
    },
    terminal_checkpoint: {
      type: 'string',
      pattern: '^[A-Z][A-Z0-9-]+$',
      maxLength: 16000,
    },
    limitations: {
      type: 'array',
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 16000,
      },
      minItems: 1,
      maxItems: 2000,
    },
    source_archives: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repository: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          filename: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          sha256: {
            type: 'string',
            pattern: '^[a-f0-9]{64}$',
            maxLength: 16000,
          },
          artifact_revision: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
        },
        required: ['repository', 'filename', 'sha256', 'artifact_revision'],
      },
      minItems: 1,
      maxItems: 2000,
    },
    previous_definition: {
      type: 'object',
      additionalProperties: false,
      properties: {
        revision: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
        },
        snapshot_path: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
        sha256: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
          maxLength: 16000,
        },
        archive_sha256: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
          maxLength: 16000,
        },
        approval_inherited: {
          const: false,
        },
      },
      required: ['revision', 'snapshot_path', 'sha256', 'archive_sha256', 'approval_inherited'],
    },
    resource_profiles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          description: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          requires_hardware_virtualization: {
            type: 'boolean',
          },
          fixture_authorization_required: {
            type: 'boolean',
          },
        },
        required: [
          'id',
          'description',
          'requires_hardware_virtualization',
          'fixture_authorization_required',
        ],
      },
      minItems: 1,
      maxItems: 2000,
    },
    acceptance_coverage: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          source_id: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          source_record_sha256: {
            type: 'string',
            pattern: '^[a-f0-9]{64}$',
            maxLength: 16000,
          },
          checkpoint: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          owner_work_item: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          producing_slices: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 16000,
            },
            minItems: 1,
            maxItems: 2000,
          },
          requires_kata_host: {
            type: 'boolean',
          },
          evidence_status_on_import: {
            const: 'unresolved',
          },
        },
        required: [
          'id',
          'source_id',
          'source_record_sha256',
          'checkpoint',
          'owner_work_item',
          'producing_slices',
          'requires_kata_host',
          'evidence_status_on_import',
        ],
      },
      minItems: 1,
      maxItems: 2000,
    },
    planning_targets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          checkpoint: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          scope: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          is_release: {
            type: 'boolean',
          },
        },
        required: ['id', 'checkpoint', 'scope', 'is_release'],
      },
      minItems: 1,
      maxItems: 2000,
    },
    aq_baseline_binding: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repository: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
        source_status: {
          const: 'implemented-source-supplied',
        },
        archive_sha256: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
          maxLength: 16000,
        },
        source_tree_sha256: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
          maxLength: 16000,
        },
        source_tree_file_count: {
          type: 'integer',
          minimum: 1,
        },
        implementation_commit: {
          const: null,
        },
        historical_pre_contract_commit: {
          type: 'string',
          pattern: '^[a-f0-9]{40}$',
          maxLength: 16000,
        },
        historical_commit_is_current_implementation_pin: {
          const: false,
        },
        contract: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
        crate_version: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
        conformance_package_revision: {
          type: 'integer',
          minimum: 1,
        },
        acceptance_checkpoint: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
        consumer_conformance_status: {
          const: 'not-run',
        },
        publication_checkpoint: {
          type: 'string',
          minLength: 1,
          maxLength: 16000,
        },
        publication_status: {
          const: 'not-verified',
        },
        active_work_item_count: {
          const: 0,
        },
        source_lock_ids: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          uniqueItems: true,
          maxItems: 2000,
        },
        retired_work_items: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          uniqueItems: true,
          maxItems: 2000,
        },
        retired_adr_checkpoints: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          uniqueItems: true,
          maxItems: 2000,
        },
        retired_deferred_decisions: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          uniqueItems: true,
          maxItems: 2000,
        },
      },
      required: [
        'repository',
        'source_status',
        'archive_sha256',
        'source_tree_sha256',
        'source_tree_file_count',
        'implementation_commit',
        'historical_pre_contract_commit',
        'historical_commit_is_current_implementation_pin',
        'contract',
        'crate_version',
        'conformance_package_revision',
        'acceptance_checkpoint',
        'consumer_conformance_status',
        'publication_checkpoint',
        'publication_status',
        'active_work_item_count',
        'source_lock_ids',
        'retired_work_items',
        'retired_adr_checkpoints',
        'retired_deferred_decisions',
      ],
    },
    baseline_acceptance_coverage: {
      type: 'array',
      minItems: 0,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          source_id: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          source_record_sha256: {
            type: 'string',
            pattern: '^[a-f0-9]{64}$',
            maxLength: 16000,
          },
          owner_work_item: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          producing_slice: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          capability_gate: {
            type: 'string',
            minLength: 1,
            maxLength: 16000,
          },
          status_on_import: {
            const: 'unresolved',
          },
        },
        required: [
          'id',
          'source_id',
          'source_record_sha256',
          'owner_work_item',
          'producing_slice',
          'capability_gate',
          'status_on_import',
        ],
      },
      maxItems: 2000,
    },
    upstream_transitions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          consumer: { type: 'string', minLength: 1, maxLength: 200 },
          upstream: { type: 'string', minLength: 1, maxLength: 200 },
          slice: { type: 'string', minLength: 1, maxLength: 200 },
        },
        required: ['consumer', 'upstream', 'slice'],
      },
      maxItems: 200,
    },
  },
  required: [
    '$schema',
    'document',
    'kind',
    'schema_version',
    'map_id',
    'revision',
    'status',
    'created_date',
    'automatic_activation',
    'source_files',
    'repositories',
    'decisions',
    'semantics',
    'evidence_profiles',
    'scheduling_policy',
    'resource_locks',
    'checkpoints',
    'deferred_decisions',
    'work_items',
    'slices',
    'terminal_checkpoint',
    'limitations',
    'source_archives',
    'previous_definition',
    'resource_profiles',
    'acceptance_coverage',
    'planning_targets',
    'aq_baseline_binding',
    'baseline_acceptance_coverage',
  ],
  $defs: {
    requirement: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              const: 'work_item',
            },
            id: {
              type: 'string',
              pattern: '^[a-z][a-z0-9_-]*/[A-Z][A-Z0-9_-]*$',
              maxLength: 16000,
            },
            state: {
              const: 'accepted',
            },
          },
          required: ['kind', 'id', 'state'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              const: 'slice',
            },
            id: {
              type: 'string',
              pattern: '^[a-z][a-z0-9_-]*/[A-Z][A-Z0-9_-]*/[a-z][a-z0-9-]*$',
              maxLength: 16000,
            },
            state: {
              enum: ['started', 'merged', 'verified'],
            },
          },
          required: ['kind', 'id', 'state'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              const: 'checkpoint',
            },
            id: {
              type: 'string',
              pattern: '^[A-Z][A-Z0-9-]+$',
              maxLength: 16000,
            },
            state: {
              const: 'passed',
            },
          },
          required: ['kind', 'id', 'state'],
        },
      ],
    },
  },
};
