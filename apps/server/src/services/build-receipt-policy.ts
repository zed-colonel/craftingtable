/** One frozen check or build receipt, as recorded in a run's build record. */
export interface BuildReceipt {
  readonly success: boolean;
  readonly clean: boolean;
  readonly headSha: string;
  readonly manifestDigest: string;
  readonly runId: string;
  readonly runtimeId: string;
  readonly verificationMode?: string;
  readonly policyDigest?: string;
  readonly kind?: string;
  readonly nativeVerification?: {
    readonly approvalId: string;
    readonly hostDigest: string;
    readonly auditDigest: string;
  };
}

export const parseBuildReceipts = (receipts: string): BuildReceipt[] =>
  receipts
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as BuildReceipt);

/**
 * Whether a receipt's kind can establish a verification mode's build requirement (ADR-047,
 * ADR-053). Scoped checks accept a scoped check, a pinned Cargo build or a native check made
 * under the scoped policy; local CI stays supplemental. A current-upstream build accepts only a
 * pinned Cargo build: scoped, supplementary, native and CI receipts cannot substitute for it.
 */
export function receiptKindEstablishes(
  receipt: BuildReceipt,
  mode: 'scoped-checks' | 'current-upstream-build',
): boolean {
  return mode === 'scoped-checks'
    ? receipt.verificationMode === 'scoped-checks' && receipt.kind !== 'local-ci'
    : receipt.kind === undefined && receipt.verificationMode !== 'scoped-checks';
}
