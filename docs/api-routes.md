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
- **Parameters** are the route's path parameters, each with the shared contract the daemon
  parses it with, once, before anything reads it (R-H7); handlers read the parsed values. A
  workspace route's `workspaceId` is parsed with `workspaceIdSchema` by the access check, which
  refuses one that does not parse with 404 before the body is read. A `…LookupSchema` admits
  any text and only brands it: no handler checked that parameter before R-H7, so its service
  still answers whatever it finds.
- **Refused** is the answer to a route's own parameter (not the workspace's) that does not
  parse, given once step-up and the body are settled: 404 with its message, or 400 with the
  body's message where a command read its id with its body. A route whose own parameters are
  all lookups refuses none: its service answers an unknown id (404 on most, 409 on a scope
  repair, roadmap control's own 400s first).

**137 routes:** 64 GET, 73 POST; 64 read, 29 decision, 19 control, 25 config. 126 take path parameters, 95 beyond the workspace's.

| Method | Path (under `/api/`) | Access | Tag | Step-up | Body | Parameters | Refused |
|---|---|---|---|---|---|---|---|
| POST | `auth/login` | public | control |  | `loginRequestSchema` |  |  |
| POST | `auth/logout` | session | control |  | `logoutRequestSchema` |  |  |
| POST | `auth/password` | session | control |  | `changePasswordRequestSchema` |  |  |
| GET | `auth/session` | session | read |  |  |  |  |
| GET | `auth/sessions` | session | read |  |  |  |  |
| POST | `auth/sessions/:sessionId/revoke` | session | control |  | `revokeSessionRequestSchema` | `sessionId` `sessionIdSchema` | 404 Resource not found |
| POST | `auth/step-up` | session | control |  | `stepUpRequestSchema` |  |  |
| GET | `execution-status` | session | read |  |  |  |  |
| POST | `execution-status/refresh-models` | session | control |  | `refreshModelsRequestSchema` |  |  |
| GET | `health` | public | read |  |  |  |  |
| GET | `workspaces` | session | read |  |  |  |  |
| POST | `workspaces` | session | config |  | `createWorkspaceRequestSchema` |  |  |
| GET | `workspaces/:workspaceId/attention` | member | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/audit` | owner | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/bindings` | editor | config |  | `saveConcurrencyBindingsSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id/runtime` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/audit-native` | editor | decision |  | `nativeAuditRequestSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/authorize-native` | editor | decision |  | `nativeApprovalRequestSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/checkpoint-recovery/:worktreeId` | editor | read |  |  | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema`, `worktreeId` `worktreeIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/configure` | editor | config |  | `configureRuntimeSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/decide` | editor | decision |  | `evidenceDecisionRequestSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/declare-transitions` | editor | decision |  | `upstreamTransitionRequestSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/discover` | editor | config |  | `discoverRuntimeRequestSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/generate-plan` | editor | decision |  | `generatePlanEvidenceRequestSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/inspect` | editor | config |  | `inspectDependencyRequestSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/prepare-checkpoint` | editor | decision |  | `prepareCheckpointRequestSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/preview-refresh` | editor | decision |  | `runtimeRefreshRequestSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/propose-decision` | editor | decision |  | `proposeArchitectureDecisionSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/refresh` | editor | decision |  | `applyRuntimeRefreshSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/runs/:runId/build-record` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema`, `runId` `agentRunIdLookupSchema` | none: its service answers |
| GET | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/submissions/:submissionId` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema`, `submissionId` `evidenceSubmissionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/runtime/submit` | editor | decision |  | `evidenceSubmissionRequestSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/supervision/adopt` | editor | decision |  | `adoptMapSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdSchema` | 400, as its body |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/supervision/preview` | editor | config |  | `mapSelectionSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/concurrency-definitions/:id/supervision/roadmap` | editor | config |  | `saveCrossProjectSchema` | `workspaceId` `workspaceIdSchema`, `id` `concurrencyDefinitionIdLookupSchema` | none: its service answers |
| GET | `workspaces/:workspaceId/cycles` | member | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/cycles/:cycleId/baseline-evidence` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `cycleId` `workCycleIdLookupSchema` | none: its service answers |
| GET | `workspaces/:workspaceId/cycles/:cycleId/baseline-preparation` | editor | read |  |  | `workspaceId` `workspaceIdSchema`, `cycleId` `workCycleIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/cycles/:cycleId/baseline-preparation` | editor | decision |  | `prepareBaselineRequestSchema` | `workspaceId` `workspaceIdSchema`, `cycleId` `workCycleIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/cycles/:cycleId/control` | editor | decision | an action that starts or resumes work under stored settings granting unrestricted | `controlWorkCycleRequestSchema` | `workspaceId` `workspaceIdSchema`, `cycleId` `workCycleIdLookupSchema` | none: its service answers |
| GET | `workspaces/:workspaceId/cycles/:cycleId/design-recovery` | editor | read |  |  | `workspaceId` `workspaceIdSchema`, `cycleId` `workCycleIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/cycles/:cycleId/design-recovery` | editor | decision |  | `recoverDesignRequestSchema` | `workspaceId` `workspaceIdSchema`, `cycleId` `workCycleIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/cycles/:cycleId/integration-resolution` | editor | decision |  | `integrationResolutionRequestSchema` | `workspaceId` `workspaceIdSchema`, `cycleId` `workCycleIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/cycles/:cycleId/investigation` | editor | decision |  | `investigationRequestSchema` | `workspaceId` `workspaceIdSchema`, `cycleId` `workCycleIdLookupSchema` | none: its service answers |
| GET | `workspaces/:workspaceId/cycles/:cycleId/scope-repair` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `cycleId` `workCycleIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/cycles/:cycleId/scope-repair` | editor | decision |  | `scopeRepairRequestSchema` | `workspaceId` `workspaceIdSchema`, `cycleId` `workCycleIdLookupSchema` | none: its service answers |
| GET | `workspaces/:workspaceId/diagnostics` | owner | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/events` | member | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/finalizations/:finalizationId/control` | editor | decision | the final promotion (merge), or an action that starts work under stored settings granting unrestricted | `controlFinalizationRequestSchema` | `workspaceId` `workspaceIdSchema`, `finalizationId` `finalizationIdLookupSchema` | none: its service answers |
| GET | `workspaces/:workspaceId/host-scheduling` | installation | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/host-scheduling` | installation | config |  | `saveHostSchedulingSchema` | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/imports/archives/:id` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `id` `importedArchiveIdLookupSchema` | none: its service answers |
| GET | `workspaces/:workspaceId/imports/concurrency-definitions` | member | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/imports/concurrency-definitions` | editor | config |  | `concurrencyUploadFieldsSchema` (multipart fields) | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/imports/plan-archives` | editor | config |  | `planArchiveUploadFieldsSchema` (multipart fields) | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/imports/plan-archives/preview` | editor | config |  | `planArchiveUploadFieldsSchema` (multipart fields) | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/imports/plans` | editor | config |  | `planImportFieldsSchema` (multipart fields) | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/notifications` | owner | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/notifications` | owner | config |  | `saveNotificationsRequestSchema` | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/notifications/test` | owner | control |  | `testNotificationsRequestSchema` | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/operator-wait` | member | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/plan-artifacts/:artifactId` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `artifactId` `planArtifactIdSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `planVersionId` `planVersionIdSchema` | 404 Resource not found |
| POST | `workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings` | editor | config |  | `savePlanBranchSettingsRequestSchema` | `workspaceId` `workspaceIdSchema`, `planVersionId` `planVersionIdSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/plan-versions/:planVersionId/finalizations` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `planVersionId` `planVersionIdSchema` | 404 Plan not found |
| POST | `workspaces/:workspaceId/plan-versions/:planVersionId/finalizations` | editor | control |  | `startFinalizationRequestSchema` | `workspaceId` `workspaceIdSchema`, `planVersionId` `planVersionIdSchema` | 404 Plan not found |
| GET | `workspaces/:workspaceId/plan-versions/:planVersionId/graph` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `planVersionId` `planVersionIdSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/plan-versions/:planVersionId/repository-policy` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `planVersionId` `planVersionIdSchema` | 404 Plan not found |
| POST | `workspaces/:workspaceId/plan-versions/:planVersionId/repository-policy` | editor | config |  | `saveRepositoryPolicyRequestSchema` | `workspaceId` `workspaceIdSchema`, `planVersionId` `planVersionIdSchema` | 404 Plan not found |
| GET | `workspaces/:workspaceId/projects/:projectId` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `projectId` `projectIdSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/projects/:projectId/plan-versions/:planVersionId` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `projectId` `projectIdSchema`, `planVersionId` `planVersionIdSchema` | 404 Resource not found |
| POST | `workspaces/:workspaceId/protected-ref-moves/acknowledge` | editor | decision |  | `acknowledgeProtectedRefMovesRequestSchema` | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/rename` | owner | config |  | `renameWorkspaceRequestSchema` | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/repositories` | member | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/repositories` | editor | config |  | `registerSourceRepositoryRequestSchema` | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/repositories/:repositoryId/branches` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `repositoryId` `sourceRepositoryIdSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/repositories/:repositoryId/checks` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `repositoryId` `sourceRepositoryIdSchema` | 404 Repository not found |
| POST | `workspaces/:workspaceId/repositories/:repositoryId/checks/adopt` | editor | decision |  | `adoptCheckDeclarationRequestSchema` | `workspaceId` `workspaceIdSchema`, `repositoryId` `sourceRepositoryIdSchema` | 404 Repository not found |
| POST | `workspaces/:workspaceId/repositories/:repositoryId/checks/preview` | editor | config |  | `checkDeclarationPreviewRequestSchema` | `workspaceId` `workspaceIdSchema`, `repositoryId` `sourceRepositoryIdSchema` | 404 Repository not found |
| GET | `workspaces/:workspaceId/repositories/:repositoryId/checks/receipts` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `repositoryId` `sourceRepositoryIdSchema` | 404 Repository not found |
| POST | `workspaces/:workspaceId/repositories/:repositoryId/retire` | editor | config |  | `retireSourceRepositoryRequestSchema` | `workspaceId` `workspaceIdSchema`, `repositoryId` `sourceRepositoryIdSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/roadmaps` | member | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId` | editor | config |  | `saveRoadmapRequestSchema` | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/agent-profiles` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/agent-profiles` | editor | config |  | `applyRoadmapAgentsSchema` | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/amendments` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/amendments` | editor | decision |  | `proposeMapAmendmentSchema` | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 400, as its body |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/amendments/decision` | editor | decision |  | `decideMapAmendmentSchema` | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 400, as its body |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/amendments/preview` | editor | decision |  | `mapSelectionSchema` | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 400, as its body |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/capacity` | editor | config |  | `saveRoadmapCapacitySchema` | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/cleanup` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/cleanup` | owner | control | always | `cleanupRequestSchema` | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/control` | editor | control | an action that starts or resumes work under stored settings granting unrestricted | `controlRoadmapRequestSchema` | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/decision-preparation-grant` | editor | decision |  | `decisionPreparationGrantRequestSchema` | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdLookupSchema` | none: its service answers |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/decision-preparations` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/definitions/:revision` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema`, `revision` `roadmapRevisionParamSchema` | 404 Roadmap not found |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/delegation` | editor | decision |  | `applyRoadmapDelegationSchema` | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/finalization-readiness` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/graph/:revision` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema`, `revision` `roadmapRevisionParamSchema` | 404 Roadmap not found |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/history` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdLookupSchema` | none: its service answers |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/prepare-decision` | editor | decision |  | `prepareRoadmapDecisionSchema` | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/scope-recovery` | editor | config |  | `scopeRecoveryPolicyRequestSchema` | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdLookupSchema` | none: its service answers |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/status` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/view` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| GET | `workspaces/:workspaceId/roadmaps/:roadmapId/wind-down` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| POST | `workspaces/:workspaceId/roadmaps/:roadmapId/wind-down` | editor | control | retiring a plan version | `windDownRequestSchema` | `workspaceId` `workspaceIdSchema`, `roadmapId` `roadmapIdSchema` | 404 Roadmap not found |
| GET | `workspaces/:workspaceId/roadmaps/capacities` | member | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/roadmaps/summaries` | member | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/run-profiles` | member | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/run-profiles` | editor | config |  | `saveRunProfilesRequestSchema` | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/runs` | member | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/runs/:runId` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `runId` `agentRunIdSchema` | 404 Resource not found |
| POST | `workspaces/:workspaceId/runs/:runId/control` | editor | control |  | `agentRunControlRequestSchema` | `workspaceId` `workspaceIdSchema`, `runId` `agentRunIdSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/runs/:runId/event-page` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `runId` `agentRunIdSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/runs/:runId/events` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `runId` `agentRunIdSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/runs/:runId/tool-results/:digest` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `runId` `agentRunIdSchema`, `digest` `toolResultDigestSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/runs/:runId/view` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `runId` `agentRunIdSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/snapshot` | member | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/storage` | installation | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/storage` | installation | config |  | `saveStorageRequestSchema` | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/storage/control` | installation | control |  | `storageControlRequestSchema` | `workspaceId` `workspaceIdSchema` |  |
| GET | `workspaces/:workspaceId/work-items` | member | read |  |  | `workspaceId` `workspaceIdSchema` |  |
| POST | `workspaces/:workspaceId/work-items/:workItemId/control` | editor | control |  | `workItemControlRequestSchema` | `workspaceId` `workspaceIdSchema`, `workItemId` `workItemIdSchema` | 404 Resource not found |
| POST | `workspaces/:workspaceId/work-items/:workItemId/cycles` | editor | control |  | `startWorkCycleRequestSchema` | `workspaceId` `workspaceIdSchema`, `workItemId` `workItemIdSchema` | 404 Work item not found |
| GET | `workspaces/:workspaceId/work-items/:workItemId/execution-scopes` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `workItemId` `workItemIdSchema` | 404 Resource not found |
| POST | `workspaces/:workspaceId/work-items/:workItemId/integration-evidence` | editor | control |  | `recordIntegrationEvidenceRequestSchema` | `workspaceId` `workspaceIdSchema`, `workItemId` `workItemIdSchema` | 404 Resource not found |
| POST | `workspaces/:workspaceId/work-items/:workItemId/runs` | editor | control |  | `startAgentRunRequestSchema` | `workspaceId` `workspaceIdSchema`, `workItemId` `workItemIdSchema` | 404 Resource not found |
| POST | `workspaces/:workspaceId/work-items/:workItemId/scope-scheduling` | editor | decision |  | `authorizeScopeSchedulingRequestSchema` | `workspaceId` `workspaceIdSchema`, `workItemId` `workItemIdSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/work-items/:workItemId/view` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `workItemId` `workItemIdSchema` | 404 Resource not found |
| POST | `workspaces/:workspaceId/work-items/:workItemId/worktrees` | editor | control |  | `createWorktreeRequestSchema` | `workspaceId` `workspaceIdSchema`, `workItemId` `workItemIdSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/worktrees/:worktreeId/branch-status` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `worktreeId` `worktreeIdSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/worktrees/:worktreeId/check-definitions` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `worktreeId` `worktreeIdSchema` | 404 Worktree not found |
| POST | `workspaces/:workspaceId/worktrees/:worktreeId/control` | editor | control |  | `worktreeControlRequestSchema` | `workspaceId` `workspaceIdSchema`, `worktreeId` `worktreeIdSchema` | 404 Resource not found |
| GET | `workspaces/:workspaceId/worktrees/:worktreeId/diff` | member | read |  |  | `workspaceId` `workspaceIdSchema`, `worktreeId` `worktreeIdSchema` | 404 Resource not found |
| POST | `workspaces/:workspaceId/worktrees/:worktreeId/merge` | editor | decision | a merge into the repository's default branch (a final promotion) | `mergeWorktreeRequestSchema` | `workspaceId` `workspaceIdSchema`, `worktreeId` `worktreeIdSchema` | 404 Resource not found |
| POST | `workspaces/:workspaceId/worktrees/:worktreeId/scope-evidence` | editor | decision |  | `recordScopeReceiptRequestSchema` | `workspaceId` `workspaceIdSchema`, `worktreeId` `worktreeIdSchema` | 404 Resource not found |
