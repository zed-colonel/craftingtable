# R-H5: the route table before (characterization at `cc222b8`)

Taken before any R-H5 change, from the daemon's registered route table (method, path and declared access, read through `declaredRouteAccess` on a test daemon) and the route sources (step-up declarations and the schema each handler parses its body with; a route registered in a loop was read by hand). Every mutation also needs step-up when its body grants `unrestricted` anywhere (R-G9), so "Step-up" names only a route's own rule.

**147 API routes:** 66 GET, 81 POST. Four declare their own step-up rule. One POST reads no body (`runtime/audit-native` ignores it); four are multipart uploads checked by hand (`plan-imports`, `plan-archives/preview`, `plan-archives/import`, `concurrency-imports`).

| Method | Path (under `/api/`) | Access | Step-up | Body schema |
|---|---|---|---|---|
| POST | `auth/login` | public |  | `loginRequestSchema` |
| POST | `auth/logout` | session |  | `logoutRequestSchema` |
| POST | `auth/password` | session |  | `changePasswordRequestSchema` |
| GET | `auth/session` | session |  |  |
| GET | `auth/sessions` | session |  |  |
| POST | `auth/sessions/:sessionId/revoke` | session |  | `revokeSessionRequestSchema` |
| POST | `auth/step-up` | session |  | `stepUpRequestSchema` |
| GET | `execution-status` | session |  |  |
| POST | `execution-status/refresh-models` | session |  | `refreshModelsRequestSchema` |
| GET | `health` | public |  |  |
| GET | `workspaces` | session |  |  |
| POST | `workspaces` | session |  | `createWorkspaceRequestSchema` |
| GET | `workspaces/:workspaceId/attention` | member |  |  |
| GET | `workspaces/:workspaceId/audit` | owner |  |  |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id` | member |  |  |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/bindings` | editor |  | `saveConcurrencyBindingsSchema` |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id/runtime` | member |  |  |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/audit-native` | editor |  | (none: body ignored) |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/authorize-native` | editor |  | `nativeApprovalRequestSchema` |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/checkpoint-recovery/:worktreeId` | editor |  |  |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/configure` | editor |  | `configureRuntimeSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/decide` | editor |  | `evidenceDecisionRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/declare-transitions` | editor |  | `upstreamTransitionRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/discover` | editor |  | `discoverRuntimeRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/generate-plan` | editor |  | `generatePlanEvidenceRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/inspect` | editor |  | `inspectDependencyRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/prepare-checkpoint` | editor |  | `prepareCheckpointRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/preview-refresh` | editor |  | `runtimeRefreshRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/propose-decision` | editor |  | `proposeArchitectureDecisionSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/refresh` | editor |  | `applyRuntimeRefreshSchema` |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/runs/:runId/build-record` | member |  |  |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/submissions/:submissionId` | member |  |  |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/submit` | editor |  | `evidenceSubmissionRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/supervision/adopt` | editor |  | `adoptMapSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/supervision/preview` | editor |  | `mapSelectionSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/supervision/roadmap` | editor |  | `saveCrossProjectSchema` |
| GET | `workspaces/:workspaceId/concurrency-imports` | member |  |  |
| POST | `workspaces/:workspaceId/concurrency-imports` | editor |  | multipart: hand checks (fields) |
| GET | `workspaces/:workspaceId/cycles` | member |  |  |
| GET | `workspaces/:workspaceId/cycles/:cycleId/baseline-evidence` | member |  |  |
| GET | `workspaces/:workspaceId/cycles/:cycleId/baseline-preparation` | editor |  |  |
| POST | `workspaces/:workspaceId/cycles/:cycleId/baseline-preparation` | editor |  | `prepareBaselineRequestSchema` |
| POST | `workspaces/:workspaceId/cycles/:cycleId/control` | editor | route rule: an action that starts agent work under a stored cycle granting unrestricted | `controlWorkCycleRequestSchema` |
| GET | `workspaces/:workspaceId/cycles/:cycleId/design-recovery` | editor |  |  |
| POST | `workspaces/:workspaceId/cycles/:cycleId/design-recovery` | editor |  | `recoverDesignRequestSchema` |
| POST | `workspaces/:workspaceId/cycles/:cycleId/integration-resolution` | editor |  | `integrationResolutionRequestSchema` |
| POST | `workspaces/:workspaceId/cycles/:cycleId/investigation` | editor |  | `startInvestigationRequestSchema` |
| POST | `workspaces/:workspaceId/cycles/:cycleId/investigation/acknowledge-change` | editor |  | `acknowledgeInvestigationChangeRequestSchema` |
| POST | `workspaces/:workspaceId/cycles/:cycleId/investigation/end` | editor |  | `endInvestigationRequestSchema` |
| GET | `workspaces/:workspaceId/cycles/:cycleId/scope-repair` | member |  |  |
| POST | `workspaces/:workspaceId/cycles/:cycleId/scope-repair` | editor |  | `scopeRepairRequestSchema` |
| GET | `workspaces/:workspaceId/diagnostics` | owner |  |  |
| GET | `workspaces/:workspaceId/events` | member |  |  |
| POST | `workspaces/:workspaceId/finalizations/:finalizationId/control` | editor | route rule: final promotion, or work under a stored finalization granting unrestricted | `controlFinalizationRequestSchema` |
| GET | `workspaces/:workspaceId/host-scheduling` | installation |  |  |
| POST | `workspaces/:workspaceId/host-scheduling` | installation |  | `saveHostSchedulingSchema` |
| GET | `workspaces/:workspaceId/import-archives/:id` | member |  |  |
| GET | `workspaces/:workspaceId/notifications` | owner |  |  |
| POST | `workspaces/:workspaceId/notifications` | owner |  | `saveNotificationsRequestSchema` |
| POST | `workspaces/:workspaceId/notifications/test` | owner |  | `testNotificationsRequestSchema` |
| GET | `workspaces/:workspaceId/operator-wait` | member |  |  |
| POST | `workspaces/:workspaceId/plan-archives/import` | editor |  | multipart: archiveSelectionSchema + hand checks (fields) |
| POST | `workspaces/:workspaceId/plan-archives/preview` | editor |  | multipart: archiveSelectionSchema (fields) |
| GET | `workspaces/:workspaceId/plan-artifacts/:artifactId` | member |  |  |
| GET | `workspaces/:workspaceId/plan-imports` | member |  |  |
| POST | `workspaces/:workspaceId/plan-imports` | editor |  | multipart: hand checks (fields) |
| GET | `workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings` | member |  |  |
| POST | `workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings` | editor |  | `savePlanBranchSettingsRequestSchema` |
| GET | `workspaces/:workspaceId/plan-versions/:planVersionId/graph` | member |  |  |
| GET | `workspaces/:workspaceId/plan-versions/:planVersionId/repository-policy` | member |  |  |
| POST | `workspaces/:workspaceId/plan-versions/:planVersionId/repository-policy` | editor |  | `saveRepositoryPolicyRequestSchema` |
| GET | `workspaces/:workspaceId/plans/:planVersionId/finalizations` | member |  |  |
| POST | `workspaces/:workspaceId/plans/:planVersionId/finalizations` | editor |  | `startFinalizationRequestSchema` |
| GET | `workspaces/:workspaceId/projects` | member |  |  |
| GET | `workspaces/:workspaceId/projects/:projectId` | member |  |  |
| GET | `workspaces/:workspaceId/projects/:projectId/plan-versions/:planVersionId` | member |  |  |
| POST | `workspaces/:workspaceId/protected-ref-moves/acknowledge` | editor |  | `acknowledgeProtectedRefMovesRequestSchema` |
| POST | `workspaces/:workspaceId/rename` | owner |  | `renameWorkspaceRequestSchema` |
| GET | `workspaces/:workspaceId/repositories` | member |  |  |
| POST | `workspaces/:workspaceId/repositories` | editor |  | `registerSourceRepositoryRequestSchema` |
| GET | `workspaces/:workspaceId/repositories/:repositoryId/branches` | member |  |  |
| GET | `workspaces/:workspaceId/repositories/:repositoryId/checks` | member |  |  |
| POST | `workspaces/:workspaceId/repositories/:repositoryId/checks/adopt` | editor |  | `adoptCheckDeclarationRequestSchema` |
| POST | `workspaces/:workspaceId/repositories/:repositoryId/checks/preview` | editor |  | `checkDeclarationPreviewRequestSchema` |
| GET | `workspaces/:workspaceId/repositories/:repositoryId/checks/receipts` | member |  |  |
| POST | `workspaces/:workspaceId/repositories/:repositoryId/retire` | editor |  | `retireSourceRepositoryRequestSchema` |
| GET | `workspaces/:workspaceId/roadmaps` | member |  |  |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId` | editor |  | `saveRoadmapRequestSchema` |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/agent-profiles` | member |  |  |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/agent-profiles` | editor |  | `applyRoadmapAgentsSchema` |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/amendments` | member |  |  |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/amendments` | editor |  | `proposeMapAmendmentSchema` |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/amendments/decision` | editor |  | `decideMapAmendmentSchema` |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/amendments/preview` | editor |  | `mapSelectionSchema` |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/capacity` | editor |  | `saveRoadmapCapacitySchema` |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/control` | editor | route rule: an action that starts agent work under a stored roadmap granting unrestricted | `controlRoadmapRequestSchema` |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/decision-preparation-grant` | editor |  | `decisionPreparationGrantRequestSchema` |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/decision-preparations` | member |  |  |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/definitions/:revision` | member |  |  |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/delegation` | editor |  | `applyRoadmapDelegationSchema` |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/finalization-readiness` | member |  |  |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/graph/:revision` | member |  |  |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/history` | member |  |  |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/prepare-decision` | editor |  | `prepareRoadmapDecisionSchema` |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/scope-recovery` | editor |  | `scopeRecoveryPolicyRequestSchema` |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/status` | member |  |  |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/view` | member |  |  |
| GET | `workspaces/:workspaceId/roadmaps/capacities` | member |  |  |
| GET | `workspaces/:workspaceId/roadmaps/summaries` | member |  |  |
| GET | `workspaces/:workspaceId/run-profiles` | member |  |  |
| POST | `workspaces/:workspaceId/run-profiles` | editor |  | `saveRunProfilesRequestSchema` |
| GET | `workspaces/:workspaceId/runs` | member |  |  |
| GET | `workspaces/:workspaceId/runs/:runId` | member |  |  |
| POST | `workspaces/:workspaceId/runs/:runId/cancel` | editor |  | `cancelAgentRunRequestSchema` |
| POST | `workspaces/:workspaceId/runs/:runId/end` | editor |  | `endAgentRunRequestSchema` |
| GET | `workspaces/:workspaceId/runs/:runId/event-page` | member |  |  |
| GET | `workspaces/:workspaceId/runs/:runId/events` | member |  |  |
| POST | `workspaces/:workspaceId/runs/:runId/messages` | editor |  | `sendAgentRunMessageRequestSchema` |
| GET | `workspaces/:workspaceId/runs/:runId/tool-results/:digest` | member |  |  |
| GET | `workspaces/:workspaceId/runs/:runId/view` | member |  |  |
| GET | `workspaces/:workspaceId/snapshot` | member |  |  |
| GET | `workspaces/:workspaceId/storage` | installation |  |  |
| POST | `workspaces/:workspaceId/storage` | installation |  | `saveStorageRequestSchema` |
| POST | `workspaces/:workspaceId/storage/backup` | installation |  | `storageCommandSchema` |
| POST | `workspaces/:workspaceId/storage/clean` | installation |  | `cleanupStorageRequestSchema` |
| POST | `workspaces/:workspaceId/storage/scan` | installation |  | `storageCommandSchema` |
| GET | `workspaces/:workspaceId/work-items` | member |  |  |
| GET | `workspaces/:workspaceId/work-items/:workItemId` | member |  |  |
| POST | `workspaces/:workspaceId/work-items/:workItemId/admit` | editor |  | `admitWorkItemRequestSchema` |
| POST | `workspaces/:workspaceId/work-items/:workItemId/complete` | editor |  | `completeWorkItemRequestSchema` |
| POST | `workspaces/:workspaceId/work-items/:workItemId/cycles` | editor |  | `startWorkCycleRequestSchema` |
| GET | `workspaces/:workspaceId/work-items/:workItemId/execution` | member |  |  |
| GET | `workspaces/:workspaceId/work-items/:workItemId/execution-scopes` | member |  |  |
| POST | `workspaces/:workspaceId/work-items/:workItemId/integration-evidence` | editor |  | `recordIntegrationEvidenceRequestSchema` |
| POST | `workspaces/:workspaceId/work-items/:workItemId/remove-from-agenda` | editor |  | `removeFromAgendaRequestSchema` |
| POST | `workspaces/:workspaceId/work-items/:workItemId/runs` | editor |  | `startAgentRunRequestSchema` |
| POST | `workspaces/:workspaceId/work-items/:workItemId/scope-scheduling` | editor |  | `authorizeScopeSchedulingRequestSchema` |
| GET | `workspaces/:workspaceId/work-items/:workItemId/view` | member |  |  |
| POST | `workspaces/:workspaceId/work-items/:workItemId/worktrees` | editor |  | `createWorktreeRequestSchema` |
| GET | `workspaces/:workspaceId/worktrees/:worktreeId/branch-status` | member |  |  |
| GET | `workspaces/:workspaceId/worktrees/:worktreeId/check-definitions` | member |  |  |
| GET | `workspaces/:workspaceId/worktrees/:worktreeId/diff` | member |  |  |
| POST | `workspaces/:workspaceId/worktrees/:worktreeId/merge` | editor | route rule: a merge into the repository's default branch | `mergeWorktreeRequestSchema` |
| POST | `workspaces/:workspaceId/worktrees/:worktreeId/remove` | editor |  | `removeWorktreeRequestSchema` |
| POST | `workspaces/:workspaceId/worktrees/:worktreeId/retarget` | editor |  | `retargetWorktreeRequestSchema` |
| POST | `workspaces/:workspaceId/worktrees/:worktreeId/scope-evidence` | editor |  | `recordScopeReceiptRequestSchema` |
| POST | `workspaces/:workspaceId/worktrees/:worktreeId/update` | editor |  | `updateWorktreeRequestSchema` |
