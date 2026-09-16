/** Frozen source identity. Whole-item execution has no additional scope. */
export interface ExecutionScope {
  readonly kind: 'slice' | 'slice-verification' | 'parent-acceptance';
  readonly definitionId: string;
  readonly bindingRevision: number;
  readonly sourceId: string;
}
export function executionScopeKey(scope?: ExecutionScope): string {
  return scope
    ? `${scope.definitionId}:${scope.bindingRevision}:${scope.kind}:${scope.sourceId}`
    : 'whole-item';
}
export function sameExecutionScope(a?: ExecutionScope, b?: ExecutionScope): boolean {
  return executionScopeKey(a) === executionScopeKey(b);
}
export interface ScopeReviewEvidence {
  readonly scope: ExecutionScope;
  readonly requirements: readonly { readonly requirement: string; readonly evidence: string }[];
  readonly caseIds: readonly string[];
}
/** Immutable operator acceptance of an independently reviewed execution scope. */
export interface ScopeReceipt {
  readonly id: string;
  readonly workspaceId: import('./ids.js').WorkspaceId;
  readonly workItemId: import('./ids.js').WorkItemId;
  readonly scope: ExecutionScope;
  readonly worktreeId: import('./ids.js').WorktreeId;
  readonly reviewRunId: import('./ids.js').AgentRunId;
  readonly headSha: string;
  readonly integrationSha: string;
  readonly evidence: ScopeReviewEvidence;
  readonly recordedAt: string;
  readonly recordedByUserId: import('./ids.js').UserId;
}
