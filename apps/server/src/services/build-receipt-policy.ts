import type { RepositoryCheckDeclaration } from '@craftingtable/domain';

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
  /**
   * Who asked for the check (R-G13 increment 3): the daemon before a review, or the agent.
   * Receipts recorded before the field existed were all the agent's.
   */
  readonly origin?: 'daemon' | 'agent';
  /** A run of an adopted check (R-G13), with its definition files' digests at the time. */
  readonly declaredCheck?: {
    readonly id: string;
    readonly declarationId: string;
    readonly definitionDigests: Readonly<Record<string, string>>;
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

/**
 * What a scoped gate held to declared checks still lacks (R-G13): each adopted check needs a
 * receipt the gate `accepts` (successful, clean, on the gated commit, of this run) recording a
 * run of that check under this declaration, with its definition files as adopted. `changed`
 * names a check that ran only with other definitions; `missing`, one that did not run at all.
 * Receipts of commands the agent chose never count here. `pending` holds the definitions a
 * merge the operator approves would adopt (R-G13 increment 5): a file that ran as it holds them
 * counts, as it will once the merge adopts them.
 */
export function declaredCheckGaps(
  declaration: RepositoryCheckDeclaration,
  receipts: readonly BuildReceipt[],
  accepts: (receipt: BuildReceipt) => boolean,
  adoptedSince?: RepositoryCheckDeclaration,
  pending?: Readonly<Record<string, string>>,
): {
  readonly missing: readonly string[];
  readonly changed: readonly { checkId: string; paths: readonly string[] }[];
} {
  const missing: string[] = [];
  const changed: { checkId: string; paths: string[] }[] = [];
  for (const check of declaration.checks) {
    const ran = receipts.filter(
      (r) =>
        accepts(r) &&
        r.declaredCheck?.id === check.id &&
        r.declaredCheck.declarationId === declaration.id,
    );
    // Definitions the operator adopted after the run, for the same command, count too: the
    // check ran with exactly what is now adopted (R-G13 review).
    const later = adoptedSince?.checks.find(
      (c) =>
        c.id === check.id &&
        JSON.stringify(c.argv) === JSON.stringify(check.argv) &&
        JSON.stringify(c.definitionPaths) === JSON.stringify(check.definitionPaths),
    );
    const differs = (r: BuildReceipt) => {
      const from = (adopted: Readonly<Record<string, string>>) =>
        check.definitionPaths.filter(
          (path) =>
            r.declaredCheck?.definitionDigests[path] !== adopted[path] &&
            (pending?.[path] === undefined ||
              r.declaredCheck?.definitionDigests[path] !== pending[path]),
        );
      const held = from(declaration.definitionDigests);
      return held.length && later && !from(adoptedSince!.definitionDigests).length ? [] : held;
    };
    if (!ran.length) missing.push(check.id);
    else if (ran.every((r) => differs(r).length))
      changed.push({ checkId: check.id, paths: differs(ran.at(-1)!) });
  }
  return { missing, changed };
}
