import type { AcceptanceCaseId, ConcurrencyDefinitionId } from './ids.js';
/** Frozen source identity. Whole-item execution has no additional scope. */
export interface ExecutionScope {
  readonly kind: 'slice' | 'slice-verification' | 'parent-acceptance';
  readonly definitionId: ConcurrencyDefinitionId;
  readonly bindingRevision: number;
  readonly sourceId: string;
}
/** What a scope's key reads: a scope, or its wire form, whose definition id is a plain string. */
type ScopeKeyParts = Omit<ExecutionScope, 'definitionId'> & { readonly definitionId: string };
export function executionScopeKey(scope?: ScopeKeyParts): string {
  return scope
    ? `${scope.definitionId}:${scope.bindingRevision}:${scope.kind}:${scope.sourceId}`
    : 'whole-item';
}
export function sameExecutionScope(a?: ScopeKeyParts, b?: ScopeKeyParts): boolean {
  return executionScopeKey(a) === executionScopeKey(b);
}
export interface ScopeReviewEvidence {
  readonly scope: ExecutionScope;
  readonly requirements: readonly { readonly requirement: string; readonly evidence: string }[];
  readonly caseIds: readonly AcceptanceCaseId[];
}
/** Scope evidence as its receipt records it. */
export interface RecordedScopeEvidence extends ScopeReviewEvidence {
  /**
   * R-C7 D7: the minor and nit findings a passing slice verification left open, kept as
   * follow-up work. Absent when none were open, and on receipts recorded before it existed.
   */
  readonly followUps?: readonly import('./review.js').ReviewFinding[];
}
/** Immutable operator acceptance of an independently reviewed execution scope. */
export interface ScopeReceipt {
  readonly reviewerRoles?: readonly string[];
  readonly id: string;
  readonly workspaceId: import('./ids.js').WorkspaceId;
  readonly workItemId: import('./ids.js').WorkItemId;
  readonly scope: ExecutionScope;
  readonly worktreeId: import('./ids.js').WorktreeId;
  readonly reviewRunId: import('./ids.js').AgentRunId;
  readonly headSha: string;
  readonly integrationSha: string;
  readonly evidence: RecordedScopeEvidence;
  readonly recordedAt: string;
  readonly recordedByUserId: import('./ids.js').UserId;
}
