/** Source vocabulary retained independently of execution and authoring. */
export type ConcurrencyRequirement =
  | {
      readonly kind: 'work_item';
      readonly id: string;
      readonly state: 'accepted';
    }
  | {
      readonly kind: 'slice';
      readonly id: string;
      readonly state: 'started' | 'merged' | 'verified';
    }
  | {
      readonly kind: 'checkpoint';
      readonly id: string;
      readonly state: 'passed';
    };

export type ConcurrencySource = {
  readonly $schema: 'cross-stack-concurrency-map.schema.json';
  readonly document: string;
  readonly kind: 'cross_stack_concurrency_map';
  readonly schema_version: '0.3.0';
  readonly map_id: string;
  readonly revision: string;
  readonly status: 'draft';
  readonly created_date: string;
  readonly automatic_activation: false;
  readonly source_files: ReadonlyArray<{
    readonly id: string;
    readonly original_path: string;
    readonly snapshot_path: string;
    readonly sha256: string;
    readonly format: 'markdown' | 'yaml' | 'json';
    readonly role: 'source_only_not_an_importable_plan';
    readonly repository: string;
  }>;
  readonly repositories: ReadonlyArray<{
    readonly id: string;
    readonly repository: string;
    readonly contract: string;
    readonly planning_profile: string;
    readonly target_branch: string | null;
    readonly source_baseline_commit: string | null;
    readonly source_plan: string;
    readonly source_work_breakdown: string;
    readonly source_stack_label: string;
    readonly merge_lock: string | null;
    readonly runtime_revision_status: 'unbound' | 'source-archive-pinned';
    readonly artifact_revision: string;
    readonly supplement_sources: ReadonlyArray<string>;
    readonly role: 'implemented_upstream' | 'planned_application';
  }>;
  readonly decisions: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly proposed_resolution: string;
    readonly source_notes: ReadonlyArray<string>;
    readonly status: 'proposed_requires_approval';
  }>;
  readonly semantics: {
    readonly requirement_operator: 'all_of';
    readonly missing_or_stale_evidence: 'blocked';
    readonly parent_acceptance: string;
    readonly slice_lifecycle: readonly ['started', 'merged', 'verified'];
    readonly merge_inherits_start_requirements: true;
    readonly verification_inherits_merge_requirements: true;
    readonly start_does_not_authorize_external_effects: true;
    readonly checkpoint_prerequisites_do_not_auto_pass_checkpoint: true;
    readonly planning_order_is_not_a_dependency: true;
    readonly source_critical_path_arrays_are_not_executable_edges: true;
    readonly historical_evidence_is_immutable: true;
    readonly validity_is_scoped_to_active_pin_bindings: true;
    readonly runtime_state_is_separate_from_definition: true;
    readonly generation_changed_midflight: 'revalidate_before_merge_verify_or_accept';
    readonly unknown_references: 'reject_entire_import';
    readonly dependency_cycle: 'reject_entire_import';
    readonly unsupported_required_semantics: 'reject_entire_import';
    readonly partial_runtime_slices_require_explicit_scope: true;
    readonly profile_milestones_do_not_accept_parents: true;
    readonly source_case_owners_are_not_dependencies: true;
    readonly resource_availability_is_not_evidence: true;
    readonly source_hashes_are_not_runtime_evidence: true;
    readonly partial_core_is_not_full_upstream_gate: true;
    readonly implemented_upstream_is_not_runnable: true;
    readonly baseline_acceptance_is_not_publication: true;
    readonly baseline_case_receipts_required: true;
  };
  readonly evidence_profiles: ReadonlyArray<{
    readonly id: string;
    readonly required_evidence: ReadonlyArray<string>;
    readonly reviewer_roles: ReadonlyArray<string>;
    readonly independence_required: true;
  }>;
  readonly scheduling_policy: {
    readonly mode: 'eligibility_not_a_calendar';
    readonly no_duration_or_speedup_estimates: true;
    readonly agent_capacity: string;
    readonly resource_reservations: string;
    readonly hold_merge_lock_while_waiting_for_checkpoint: false;
    readonly recheck_before_merge: true;
    readonly required_execution_isolation: string;
    readonly priority_hint: string;
    readonly feedback_is_not_dependency: string;
    readonly suggested_focus_target: string;
    readonly target_selection: string;
    readonly resource_profile_binding: string;
  };
  readonly resource_locks: ReadonlyArray<{
    readonly id: string;
    readonly repository: string;
    readonly capacity: 1;
    readonly stage: 'merge';
    readonly scope: string;
  }>;
  readonly checkpoints: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly kind:
      | 'plan_approval'
      | 'architecture_decision'
      | 'contract'
      | 'release_candidate'
      | 'release'
      | 'integration_evidence'
      | 'semantic_review'
      | 'profile'
      | 'partial_milestone'
      | 'baseline_acceptance';
    readonly owner: string;
    readonly requires: ReadonlyArray<ConcurrencyRequirement>;
    readonly evidence_profile: string;
    readonly pass_criteria: ReadonlyArray<string>;
    readonly source_refs: ReadonlyArray<{
      readonly source_id: string;
      readonly section: string;
      readonly start_line?: number;
      readonly end_line?: number;
    }>;
    readonly status_on_import: 'unresolved';
    readonly invalidation: 'active-pin-or-evidence-change';
    readonly decision_refs: ReadonlyArray<string>;
    readonly evidence_owners?: ReadonlyArray<string>;
    readonly historical_producer_work_items?: ReadonlyArray<string>;
  }>;
  readonly deferred_decisions: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly source_due: string;
    readonly reason: string;
  }>;
  readonly work_items: ReadonlyArray<{
    readonly id: string;
    readonly repository: string;
    readonly source_item_id: string;
    readonly planning_order: number;
    readonly title: string;
    readonly source_record_sha256: string;
    readonly source_maturity: string;
    readonly depends_on: ReadonlyArray<string>;
    readonly primary_areas: ReadonlyArray<string>;
    readonly risk: string;
    readonly source_exit_gate: string;
    readonly source_test_reference: {
      readonly source_id: string;
      readonly section: string;
      readonly start_line: number;
      readonly end_line: number;
    };
    readonly required_slices: ReadonlyArray<string>;
    readonly acceptance_requires: ReadonlyArray<ConcurrencyRequirement>;
    readonly acceptance_evidence_profile: 'work-item-exit';
    readonly source_profile_case_ids: ReadonlyArray<string>;
    readonly profile_evidence_slices: ReadonlyArray<string>;
    readonly aq_baseline_case_ids: ReadonlyArray<string>;
  }>;
  readonly slices: ReadonlyArray<{
    readonly id: string;
    readonly work_item: string;
    readonly title: string;
    readonly mode:
      | 'domain'
      | 'implementation'
      | 'integration'
      | 'conformance'
      | 'release'
      | 'release_readiness';
    readonly scope: string;
    readonly excludes: ReadonlyArray<string>;
    readonly start_requires: ReadonlyArray<ConcurrencyRequirement>;
    readonly merge_requires: ReadonlyArray<ConcurrencyRequirement>;
    readonly verify_requires: ReadonlyArray<ConcurrencyRequirement>;
    readonly evidence_profile: string;
    readonly merge_lock: string;
    readonly workspace_policy: 'isolated-worktree-and-test-state';
    readonly early_start_exception: boolean;
    readonly source_refs: ReadonlyArray<{
      readonly source_id: string;
      readonly section: string;
      readonly start_line?: number;
      readonly end_line?: number;
    }>;
    readonly decision_refs: ReadonlyArray<string>;
    readonly grants_effect_authority: false;
    readonly partial_scope: 'full' | 'domain' | 'embedded-proof' | 'supervisor-proof';
    readonly resources_by_phase: {
      readonly start: ReadonlyArray<string>;
      readonly merge: ReadonlyArray<string>;
      readonly verify: ReadonlyArray<string>;
    };
    readonly planning_target_class: string;
    readonly aq_baseline_case_ids: ReadonlyArray<string>;
  }>;
  readonly terminal_checkpoint: string;
  readonly limitations: ReadonlyArray<string>;
  readonly source_archives: ReadonlyArray<{
    readonly repository: string;
    readonly filename: string;
    readonly sha256: string;
    readonly artifact_revision: string;
  }>;
  readonly previous_definition: {
    readonly revision: string;
    readonly snapshot_path: string;
    readonly sha256: string;
    readonly archive_sha256: string;
    readonly approval_inherited: false;
  };
  readonly resource_profiles: ReadonlyArray<{
    readonly id: string;
    readonly description: string;
    readonly requires_hardware_virtualization: boolean;
    readonly fixture_authorization_required: boolean;
  }>;
  readonly acceptance_coverage: ReadonlyArray<{
    readonly id: string;
    readonly source_id: string;
    readonly source_record_sha256: string;
    readonly checkpoint: string;
    readonly owner_work_item: string;
    readonly producing_slices: ReadonlyArray<string>;
    readonly requires_kata_host: boolean;
    readonly evidence_status_on_import: 'unresolved';
  }>;
  readonly planning_targets: ReadonlyArray<{
    readonly id: string;
    readonly checkpoint: string;
    readonly scope: string;
    readonly is_release: boolean;
  }>;
  readonly aq_baseline_binding: {
    readonly repository: string;
    readonly source_status: 'implemented-source-supplied';
    readonly archive_sha256: string;
    readonly source_tree_sha256: string;
    readonly source_tree_file_count: number;
    readonly implementation_commit: null;
    readonly historical_pre_contract_commit: string;
    readonly historical_commit_is_current_implementation_pin: false;
    readonly contract: string;
    readonly crate_version: string;
    readonly conformance_package_revision: number;
    readonly acceptance_checkpoint: string;
    readonly consumer_conformance_status: 'not-run';
    readonly publication_checkpoint: string;
    readonly publication_status: 'not-verified';
    readonly active_work_item_count: 0;
    readonly source_lock_ids: ReadonlyArray<string>;
    readonly retired_work_items: ReadonlyArray<string>;
    readonly retired_adr_checkpoints: ReadonlyArray<string>;
    readonly retired_deferred_decisions: ReadonlyArray<string>;
  };
  readonly baseline_acceptance_coverage: ReadonlyArray<{
    readonly id: string;
    readonly source_id: string;
    readonly source_record_sha256: string;
    readonly owner_work_item: string;
    readonly producing_slice: string;
    readonly capability_gate: string;
    readonly status_on_import: 'unresolved';
  }>;
  /** Optional (ADR-069): the slice whose merge moves each consumer→upstream link to the current pin. */
  readonly upstream_transitions?: ReadonlyArray<{
    readonly consumer: string;
    readonly upstream: string;
    readonly slice: string;
  }>;
};
