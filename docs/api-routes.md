# API routes

Generated from the daemon's route table by `pnpm routes:inventory` (R-H5); do not edit by hand.
The route inventory test fails when this file and the route table differ, and the web's
decision boundary test reads each `decision` route from it.

- **Access** is the least role a route admits (`route-access.ts`): `public`, `session`, or a
  workspace role (`member`, `editor`, `owner`), or `installation` (the owner of every active
  workspace). Every command also needs the CSRF token and an allowed origin.
- **Tag** says what a route does: a `read`; a `decision` (resolves an operator decision, posted
  from one decision component in the browser, R-A6); a `control` (acts on work in progress or
  on the session); or `config` (settings, imports and definitions).
- **Step-up** is the route's own rule for asking for the password again (R-G9). Every command
  also asks when its body grants `unrestricted` anywhere.
- **Body** is the shared contract the daemon parses a command's body with before its handler
  runs; for a multipart upload, its text fields.

**137 routes:** 66 GET, 71 POST; 66 read, 29 decision, 17 control, 25 config.

| Method | Path (under `/api/`) | Access | Tag | Step-up | Body |
|---|---|---|---|---|---|
| POST | `auth/login` | public | control |  | `loginRequestSchema` |
| POST | `auth/logout` | session | control |  | `logoutRequestSchema` |
| POST | `auth/password` | session | control |  | `changePasswordRequestSchema` |
| GET | `auth/session` | session | read |  |  |
| GET | `auth/sessions` | session | read |  |  |
| POST | `auth/sessions/:sessionId/revoke` | session | control |  | `revokeSessionRequestSchema` |
| POST | `auth/step-up` | session | control |  | `stepUpRequestSchema` |
| GET | `execution-status` | session | read |  |  |
| POST | `execution-status/refresh-models` | session | control |  | `refreshModelsRequestSchema` |
| GET | `health` | public | read |  |  |
| GET | `workspaces` | session | read |  |  |
| POST | `workspaces` | session | config |  | `createWorkspaceRequestSchema` |
| GET | `workspaces/:workspaceId/attention` | member | read |  |  |
| GET | `workspaces/:workspaceId/audit` | owner | read |  |  |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id` | member | read |  |  |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/bindings` | editor | config |  | `saveConcurrencyBindingsSchema` |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id/runtime` | member | read |  |  |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/audit-native` | editor | decision |  | `nativeAuditRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/authorize-native` | editor | decision |  | `nativeApprovalRequestSchema` |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/checkpoint-recovery/:worktreeId` | editor | read |  |  |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/configure` | editor | config |  | `configureRuntimeSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/decide` | editor | decision |  | `evidenceDecisionRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/declare-transitions` | editor | decision |  | `upstreamTransitionRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/discover` | editor | config |  | `discoverRuntimeRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/generate-plan` | editor | decision |  | `generatePlanEvidenceRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/inspect` | editor | config |  | `inspectDependencyRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/prepare-checkpoint` | editor | decision |  | `prepareCheckpointRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/preview-refresh` | editor | decision |  | `runtimeRefreshRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/propose-decision` | editor | decision |  | `proposeArchitectureDecisionSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/refresh` | editor | decision |  | `applyRuntimeRefreshSchema` |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/runs/:runId/build-record` | member | read |  |  |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/submissions/:submissionId` | member | read |  |  |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/submit` | editor | decision |  | `evidenceSubmissionRequestSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/supervision/adopt` | editor | decision |  | `adoptMapSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/supervision/preview` | editor | config |  | `mapSelectionSchema` |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/supervision/roadmap` | editor | config |  | `saveCrossProjectSchema` |
| GET | `workspaces/:workspaceId/cycles` | member | read |  |  |
| GET | `workspaces/:workspaceId/cycles/:cycleId/baseline-evidence` | member | read |  |  |
| GET | `workspaces/:workspaceId/cycles/:cycleId/baseline-preparation` | editor | read |  |  |
| POST | `workspaces/:workspaceId/cycles/:cycleId/baseline-preparation` | editor | decision |  | `prepareBaselineRequestSchema` |
| POST | `workspaces/:workspaceId/cycles/:cycleId/control` | editor | decision | an action that starts or resumes work under stored settings granting unrestricted | `controlWorkCycleRequestSchema` |
| GET | `workspaces/:workspaceId/cycles/:cycleId/design-recovery` | editor | read |  |  |
| POST | `workspaces/:workspaceId/cycles/:cycleId/design-recovery` | editor | decision |  | `recoverDesignRequestSchema` |
| POST | `workspaces/:workspaceId/cycles/:cycleId/integration-resolution` | editor | decision |  | `integrationResolutionRequestSchema` |
| POST | `workspaces/:workspaceId/cycles/:cycleId/investigation` | editor | decision |  | `investigationRequestSchema` |
| GET | `workspaces/:workspaceId/cycles/:cycleId/scope-repair` | member | read |  |  |
| POST | `workspaces/:workspaceId/cycles/:cycleId/scope-repair` | editor | decision |  | `scopeRepairRequestSchema` |
| GET | `workspaces/:workspaceId/diagnostics` | owner | read |  |  |
| GET | `workspaces/:workspaceId/events` | member | read |  |  |
| POST | `workspaces/:workspaceId/finalizations/:finalizationId/control` | editor | decision | the final promotion (merge), or an action that starts work under stored settings granting unrestricted | `controlFinalizationRequestSchema` |
| GET | `workspaces/:workspaceId/host-scheduling` | installation | read |  |  |
| POST | `workspaces/:workspaceId/host-scheduling` | installation | config |  | `saveHostSchedulingSchema` |
| GET | `workspaces/:workspaceId/imports/archives/:id` | member | read |  |  |
| GET | `workspaces/:workspaceId/imports/concurrency-definitions` | member | read |  |  |
| POST | `workspaces/:workspaceId/imports/concurrency-definitions` | editor | config |  | `concurrencyUploadFieldsSchema` (multipart fields) |
| POST | `workspaces/:workspaceId/imports/plan-archives` | editor | config |  | `planArchiveUploadFieldsSchema` (multipart fields) |
| POST | `workspaces/:workspaceId/imports/plan-archives/preview` | editor | config |  | `planArchiveUploadFieldsSchema` (multipart fields) |
| GET | `workspaces/:workspaceId/imports/plans` | member | read |  |  |
| POST | `workspaces/:workspaceId/imports/plans` | editor | config |  | `planImportFieldsSchema` (multipart fields) |
| GET | `workspaces/:workspaceId/notifications` | owner | read |  |  |
| POST | `workspaces/:workspaceId/notifications` | owner | config |  | `saveNotificationsRequestSchema` |
| POST | `workspaces/:workspaceId/notifications/test` | owner | control |  | `testNotificationsRequestSchema` |
| GET | `workspaces/:workspaceId/operator-wait` | member | read |  |  |
| GET | `workspaces/:workspaceId/plan-artifacts/:artifactId` | member | read |  |  |
| GET | `workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings` | member | read |  |  |
| POST | `workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings` | editor | config |  | `savePlanBranchSettingsRequestSchema` |
| GET | `workspaces/:workspaceId/plan-versions/:planVersionId/finalizations` | member | read |  |  |
| POST | `workspaces/:workspaceId/plan-versions/:planVersionId/finalizations` | editor | control |  | `startFinalizationRequestSchema` |
| GET | `workspaces/:workspaceId/plan-versions/:planVersionId/graph` | member | read |  |  |
| GET | `workspaces/:workspaceId/plan-versions/:planVersionId/repository-policy` | member | read |  |  |
| POST | `workspaces/:workspaceId/plan-versions/:planVersionId/repository-policy` | editor | config |  | `saveRepositoryPolicyRequestSchema` |
| GET | `workspaces/:workspaceId/projects` | member | read |  |  |
| GET | `workspaces/:workspaceId/projects/:projectId` | member | read |  |  |
| GET | `workspaces/:workspaceId/projects/:projectId/plan-versions/:planVersionId` | member | read |  |  |
| POST | `workspaces/:workspaceId/protected-ref-moves/acknowledge` | editor | decision |  | `acknowledgeProtectedRefMovesRequestSchema` |
| POST | `workspaces/:workspaceId/rename` | owner | config |  | `renameWorkspaceRequestSchema` |
| GET | `workspaces/:workspaceId/repositories` | member | read |  |  |
| POST | `workspaces/:workspaceId/repositories` | editor | config |  | `registerSourceRepositoryRequestSchema` |
| GET | `workspaces/:workspaceId/repositories/:repositoryId/branches` | member | read |  |  |
| GET | `workspaces/:workspaceId/repositories/:repositoryId/checks` | member | read |  |  |
| POST | `workspaces/:workspaceId/repositories/:repositoryId/checks/adopt` | editor | decision |  | `adoptCheckDeclarationRequestSchema` |
| POST | `workspaces/:workspaceId/repositories/:repositoryId/checks/preview` | editor | config |  | `checkDeclarationPreviewRequestSchema` |
| GET | `workspaces/:workspaceId/repositories/:repositoryId/checks/receipts` | member | read |  |  |
| POST | `workspaces/:workspaceId/repositories/:repositoryId/retire` | editor | config |  | `retireSourceRepositoryRequestSchema` |
| GET | `workspaces/:workspaceId/roadmaps` | member | read |  |  |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId` | editor | config |  | `saveRoadmapRequestSchema` |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/agent-profiles` | member | read |  |  |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/agent-profiles` | editor | config |  | `applyRoadmapAgentsSchema` |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/amendments` | member | read |  |  |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/amendments` | editor | decision |  | `proposeMapAmendmentSchema` |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/amendments/decision` | editor | decision |  | `decideMapAmendmentSchema` |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/amendments/preview` | editor | decision |  | `mapSelectionSchema` |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/capacity` | editor | config |  | `saveRoadmapCapacitySchema` |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/control` | editor | control | an action that starts or resumes work under stored settings granting unrestricted | `controlRoadmapRequestSchema` |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/decision-preparation-grant` | editor | decision |  | `decisionPreparationGrantRequestSchema` |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/decision-preparations` | member | read |  |  |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/definitions/:revision` | member | read |  |  |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/delegation` | editor | decision |  | `applyRoadmapDelegationSchema` |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/finalization-readiness` | member | read |  |  |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/graph/:revision` | member | read |  |  |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/history` | member | read |  |  |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/prepare-decision` | editor | decision |  | `prepareRoadmapDecisionSchema` |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/scope-recovery` | editor | config |  | `scopeRecoveryPolicyRequestSchema` |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/status` | member | read |  |  |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/view` | member | read |  |  |
| GET | `workspaces/:workspaceId/roadmaps/capacities` | member | read |  |  |
| GET | `workspaces/:workspaceId/roadmaps/summaries` | member | read |  |  |
| GET | `workspaces/:workspaceId/run-profiles` | member | read |  |  |
| POST | `workspaces/:workspaceId/run-profiles` | editor | config |  | `saveRunProfilesRequestSchema` |
| GET | `workspaces/:workspaceId/runs` | member | read |  |  |
| GET | `workspaces/:workspaceId/runs/:runId` | member | read |  |  |
| POST | `workspaces/:workspaceId/runs/:runId/control` | editor | control |  | `agentRunControlRequestSchema` |
| GET | `workspaces/:workspaceId/runs/:runId/event-page` | member | read |  |  |
| GET | `workspaces/:workspaceId/runs/:runId/events` | member | read |  |  |
| GET | `workspaces/:workspaceId/runs/:runId/tool-results/:digest` | member | read |  |  |
| GET | `workspaces/:workspaceId/runs/:runId/view` | member | read |  |  |
| GET | `workspaces/:workspaceId/snapshot` | member | read |  |  |
| GET | `workspaces/:workspaceId/storage` | installation | read |  |  |
| POST | `workspaces/:workspaceId/storage` | installation | config |  | `saveStorageRequestSchema` |
| POST | `workspaces/:workspaceId/storage/control` | installation | control |  | `storageControlRequestSchema` |
| GET | `workspaces/:workspaceId/work-items` | member | read |  |  |
| GET | `workspaces/:workspaceId/work-items/:workItemId` | member | read |  |  |
| POST | `workspaces/:workspaceId/work-items/:workItemId/control` | editor | control |  | `workItemControlRequestSchema` |
| POST | `workspaces/:workspaceId/work-items/:workItemId/cycles` | editor | control |  | `startWorkCycleRequestSchema` |
| GET | `workspaces/:workspaceId/work-items/:workItemId/execution` | member | read |  |  |
| GET | `workspaces/:workspaceId/work-items/:workItemId/execution-scopes` | member | read |  |  |
| POST | `workspaces/:workspaceId/work-items/:workItemId/integration-evidence` | editor | control |  | `recordIntegrationEvidenceRequestSchema` |
| POST | `workspaces/:workspaceId/work-items/:workItemId/runs` | editor | control |  | `startAgentRunRequestSchema` |
| POST | `workspaces/:workspaceId/work-items/:workItemId/scope-scheduling` | editor | decision |  | `authorizeScopeSchedulingRequestSchema` |
| GET | `workspaces/:workspaceId/work-items/:workItemId/view` | member | read |  |  |
| POST | `workspaces/:workspaceId/work-items/:workItemId/worktrees` | editor | control |  | `createWorktreeRequestSchema` |
| GET | `workspaces/:workspaceId/worktrees/:worktreeId/branch-status` | member | read |  |  |
| GET | `workspaces/:workspaceId/worktrees/:worktreeId/check-definitions` | member | read |  |  |
| POST | `workspaces/:workspaceId/worktrees/:worktreeId/control` | editor | control |  | `worktreeControlRequestSchema` |
| GET | `workspaces/:workspaceId/worktrees/:worktreeId/diff` | member | read |  |  |
| POST | `workspaces/:workspaceId/worktrees/:worktreeId/merge` | editor | decision | a merge into the repository's default branch (a final promotion) | `mergeWorktreeRequestSchema` |
| POST | `workspaces/:workspaceId/worktrees/:worktreeId/scope-evidence` | editor | decision |  | `recordScopeReceiptRequestSchema` |
