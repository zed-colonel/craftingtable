import type { AgentRunRole, JsonValue, ReviewBranchContext, WorkItem } from '@craftingtable/domain';
import { designInstructions, investigationInstructions } from './brief-design.js';
export { citedRunPaths } from './brief-handoff.js';
import {
  ACCEPTED_DESIGN_INSTRUCTIONS,
  implementInstructions,
  REMEDIATION_INSTRUCTIONS,
  resolutionInstructions,
} from './brief-implement.js';
import {
  finalMessageSection,
  type OutputContext,
  type RoleInstructions,
  type WorkflowOutput,
} from './brief-output.js';
import { reviewInstructions } from './brief-review.js';
import { type BriefParentRun, handoffParagraphs, parentSections } from './brief-handoff.js';

/**
 * Composes the prompt handed to an agent as its first message.
 *
 * The brief is pure data in, text out. Role templates are the composition
 * seam for orchestrated cycles: a review run reads the same work item with a
 * different role and a `parentRunId`, and a later orchestrator can chain them
 * without new vocabulary.
 */

export interface BriefDependency {
  readonly sourceId: string;
  readonly title: string;
  readonly status: WorkItem['status'];
}

export interface BriefPlanDocument {
  readonly filename: string;
  readonly role: string;
  /** Absolute path where the daemon wrote the document for this run. */
  readonly path: string;
}

/** A file CraftingTable wrote for the run. */
export interface BriefRecord {
  /** Absolute path. */
  readonly path: string;
  /** What it holds, in a phrase. */
  readonly about: string;
}

/** A directory CraftingTable supplied for the run, listed once (AGT-58). */
export interface BriefDirectory {
  /** Absolute path, without a trailing slash. */
  readonly path: string;
  /** The files to start with. */
  readonly files: readonly string[];
  /** What the directory holds, and what lists the rest. */
  readonly about: string;
}

export interface BriefInput {
  readonly repositoryPolicyGuidance?: string;
  readonly executionScope?: {
    readonly identity: import('@craftingtable/domain').ExecutionScope;
    readonly title: string;
    readonly scope: string;
    readonly excludes: readonly string[];
    readonly requirements: readonly string[];
    readonly cases: readonly string[];
    /** The parent's required slices, for a parent-acceptance review to name owners (LIVE-27). */
    readonly owningSlices?: readonly {
      readonly id: string;
      readonly scope: string;
      readonly excludes: readonly string[];
    }[];
  };
  readonly reviewContinuationArtifacts?: readonly string[];
  readonly resolvingIntegration?: boolean;
  readonly planFinalization?: boolean;
  readonly reviewReportRetry?: {
    readonly issues: readonly string[];
    readonly reuseVerification: boolean;
  };
  readonly temporaryDirectory?: string;
  /** The worktree's shared Cargo target directory, when the daemon provides one (R-G7). */
  readonly buildCacheDirectory?: string;
  /**
   * The worktree builds with Cargo: it has a `Cargo.toml`, or a pinned Cargo environment. Only
   * then does the brief speak of Cargo's build directory (R-F2 part 6, AGT-55).
   */
  readonly cargo?: boolean;
  /** What the daemon prepared for the run's builds and checks, rendered as data (AGT-55). */
  readonly environment?: BriefEnvironment;
  readonly reviewBranchContext?: ReviewBranchContext;
  readonly role: AgentRunRole;
  readonly projectName: string;
  readonly workItem: {
    readonly sourceId: string;
    readonly title: string;
    readonly risk: string;
    readonly phase?: string;
    readonly primaryAreas: readonly string[];
    readonly exitGate: string;
    readonly sourceFields: JsonValue;
  };
  readonly requiredDependencies: readonly BriefDependency[];
  readonly recommendedDependencies: readonly BriefDependency[];
  readonly worktree: {
    readonly path: string;
    readonly branchName: string;
    readonly baseBranch: string;
    readonly baseSha: string;
    readonly integrationBranch?: string;
  };
  /** The plan bundle's documents, read-only in the run's plan directory. */
  readonly planDocuments: readonly BriefPlanDocument[];
  /** The run's plan directory, where the bundle and CraftingTable's records are written. */
  readonly planDirectory?: string;
  /** The files CraftingTable wrote for this run, each with what it holds (AGT-50, part 4). */
  readonly records?: readonly BriefRecord[];
  /** Directories CraftingTable supplied for this run: the files to start with and the rest. */
  readonly directories?: readonly BriefDirectory[];
  /** Operator-authored instructions that hold for every step. */
  readonly instructions?: string;
  /** One-shot operator guidance for this run only. */
  readonly stepGuidance?: string;
  /** Controller-authored rules for this automated step. */
  readonly controllerInstructions?: string;
  /**
   * A question stop's read-only investigation (R-C16): it runs as a design-role run, but its
   * role is to investigate, and the controller's rules say what it returns.
   */
  readonly investigation?: boolean;
  /** The controller's workflow contract applies to this step (its rules are in the step rules). */
  readonly workflow?: WorkflowOutput;
  /** The staged finalization stage a review reports on. */
  readonly finalizationStage?: OutputContext['finalizationStage'];
  /** The plan has architecture checkpoints a design may propose decisions for. */
  readonly architectureDecisions?: boolean;
  /** The run this one continues from, with its final message. */
  readonly parentRun?: BriefParentRun;
}

/** A run's build environment, as the daemon prepared it (R-F2 part 6, AGT-55). */
export interface BriefEnvironment {
  readonly pinned?: BriefPinnedEnvironment;
  /** A check-only run's adopted checks, from `declaredChecksBrief` (R-G13 increment 4). */
  readonly checkOnly?: string;
  /** The controller-prepared historical baseline, for characterization only. */
  readonly historical?: {
    readonly manifestPath: string;
    readonly workspacePath: string;
    readonly launcher: string;
    readonly receiptPath: string;
  };
}

/** A pinned Cargo environment: the manifest, its launchers and the policy it enforces. */
export interface BriefPinnedEnvironment {
  readonly manifestPath: string;
  readonly binDirectory: string;
  /** The native verification approval, when the run may use `ct-native`. */
  readonly nativeApprovalId?: string;
  readonly verification: { readonly mode: string; readonly reason: string };
  readonly dependencies: readonly BriefUpstreamSource[];
  /** The run is held to its repository's adopted checks. */
  readonly adoptedChecks: boolean;
  /** Those checks and their commands, from `declaredChecksBrief`. */
  readonly declaredChecks: string;
  /** The local CI runner's image, when one is configured. */
  readonly localCiImage?: string;
  /** Some of the scope's acceptance cases need a Kata host (AGT-55: the Kata lines). */
  readonly kata: boolean;
}

export interface BriefUpstreamSource {
  readonly alias: string;
  readonly commitSha: string;
  readonly purpose: string;
  readonly transition?: { readonly slice: string; readonly recordId?: string };
}

export type { BriefFinding, BriefParentRun } from './brief-handoff.js';

/** The run's role and final message, from the one module that owns that role (AGT-54). */
function instructionsFor(input: BriefInput): RoleInstructions {
  const context: OutputContext = {
    role: input.role,
    investigation: !!input.investigation,
    resolvingIntegration: !!input.resolvingIntegration,
    planFinalization: !!input.planFinalization,
    remediation:
      !input.resolvingIntegration &&
      input.role === 'implement' &&
      input.parentRun?.role === 'review',
    ...(input.executionScope
      ? {
          scope: {
            identity: input.executionScope.identity,
            cases: input.executionScope.cases,
            ...(input.executionScope.owningSlices
              ? { owningSlices: input.executionScope.owningSlices }
              : {}),
          },
        }
      : {}),
    ...(input.workflow ? { workflow: input.workflow } : {}),
    ...(input.finalizationStage ? { finalizationStage: input.finalizationStage } : {}),
    architectureDecisions: !!input.architectureDecisions,
  };
  if (context.investigation) return investigationInstructions();
  if (context.resolvingIntegration) return resolutionInstructions();
  return context.role === 'review'
    ? reviewInstructions(context)
    : context.role === 'design'
      ? designInstructions(context)
      : implementInstructions(context);
}

function formatDependencies(entries: readonly BriefDependency[]): string {
  return entries.length === 0
    ? 'none'
    : entries.map((entry) => `${entry.sourceId}: ${entry.title} (${entry.status})`).join('; ');
}

function formatSourceFields(value: JsonValue): string {
  const serialized = JSON.stringify(value, null, 2) ?? 'null';
  return serialized.length > 20_000 ? `${serialized.slice(0, 20_000)}\n…(truncated)` : serialized;
}

/**
 * Part 1, the task (AGT-50): what this run must achieve and how it is accepted. A scope is
 * stated once (AGT-58): its statement, what it excludes, the evidence it requires and its
 * cases; the parent's exit gate is context. Identifiers and digests stay in the evidence file.
 */
function goalSection(input: BriefInput): string {
  const { workItem } = input;
  const s = input.executionScope;
  const lines: string[] = ['## Goal and acceptance', ''];
  if (s) {
    lines.push(
      `This run covers only ${s.identity.sourceId}, ${s.identity.kind === 'slice' ? 'a slice' : 'the acceptance'} of ${workItem.sourceId}.`,
      `Scope: ${s.scope}`,
      ...(s.excludes.length ? ['Not in scope:', ...s.excludes.map((e) => `- ${e}`)] : []),
      'Evidence required:',
      ...s.requirements.map((e) =>
        e === s.scope ? '- The Scope line above, word for word.' : `- ${e}`,
      ),
      `Assigned cases: ${s.cases.join(', ') || 'none'}`,
      `The parent's exit gate, which stays the parent's: ${workItem.exitGate}`,
      'Do not implement excluded work or mark the parent complete. If new requirements or dependencies are needed, report them as open questions and propose a planning amendment with its rationale and affected scopes; do not silently change the plan, map, acceptance criteria or scheduling authority.',
    );
  } else lines.push(`Exit gate: ${workItem.exitGate}`);
  lines.push(
    '',
    [
      `Risk: ${workItem.risk}`,
      ...(workItem.phase === undefined ? [] : [`Phase: ${workItem.phase}`]),
      `Primary areas: ${workItem.primaryAreas.length === 0 ? 'unspecified' : workItem.primaryAreas.join(', ')}`,
    ].join(' · '),
    '',
    `The work item ${workItem.sourceId} as the plan writes it:`,
    '```json',
    formatSourceFields(workItem.sourceFields),
    '```',
  );
  return lines.join('\n');
}

/** Part 2 (AGT-50): the worktree, its branches, its predecessors and the run's scratch. */
function whereSection(input: BriefInput): string {
  const { worktree } = input;
  const paragraphs = [
    `You are in a dedicated Git worktree at \`${worktree.path}\` on branch \`${worktree.branchName}\`, created from \`${worktree.baseBranch}\` at \`${worktree.baseSha}\`. This is the only place you may change files; the primary checkout and other worktrees of this repository are off limits.`,
  ];
  if (worktree.integrationBranch !== undefined)
    paragraphs.push(
      `Integration destination: ${worktree.integrationBranch}. Only the daemon may merge into it under the operator’s approval or recorded integration policy.`,
    );
  if (input.reviewBranchContext !== undefined) {
    const context = input.reviewBranchContext;
    paragraphs.push(
      `Review baseline: item commit ${context.headSha}; integration branch ${context.targetBranch} at ${context.targetSha}. Verify this combined state and report the checks you ran. Do not move either branch during review.`,
    );
  }
  paragraphs.push(
    `${input.executionScope ? 'Original parent predecessors (slice readiness is defined by the controller scope and evidence ledger)' : 'Predecessors'}: required ${formatDependencies(input.requiredDependencies)}; recommended ${formatDependencies(input.recommendedDependencies)}.`,
  );
  if (input.temporaryDirectory)
    paragraphs.push(
      `Temporary files: TMPDIR, TMP, and TEMP point to ${input.temporaryDirectory}. Use this controller-owned directory for test temporary files and scratch output. It is outside the Git worktree and available to this run. Do not redirect temporary files to the worktree root. Do not commit test artifacts. Preserve verification results in your final message. ${
        !input.cargo
          ? ''
          : input.buildCacheDirectory
            ? `CARGO_TARGET_DIR points to ${input.buildCacheDirectory}, this worktree’s build cache. Earlier steps in this worktree built into it, so builds are incremental; keep build outputs there rather than creating another target directory, and do not put evidence inside it. It is removed when the worktree is merged or removed.${input.environment?.pinned ? ' The supplied Cargo launcher and CraftingTable’s checks use their own build directories instead (see the build environment below).' : ''} `
            : 'CARGO_TARGET_DIR points to this run’s scratch/target build cache. Keep build outputs there and do not put evidence inside a build cache. Recognized build caches are disposable and may be removed when this run ends, including failed or cancelled runs. '
      }Verification logs and reports belong in separate scratch/verification or scratch/review directories. Other scratch may expire under the storage policy, and source edits remain restricted to the worktree; this directory is for temporary data only.`,
    );
  return `## Where you are\n\n${paragraphs.join('\n\n')}`;
}

/** How many plan documents are named one by one; a larger bundle is listed as its directory. */
const NAMED_PLAN_DOCUMENTS = 6;

/**
 * Part 4 (AGT-50): the files to read. The plan bundle is one directory (AGT-58): its plan and
 * work breakdown are named, and a large bundle's supporting documents are counted. Each of
 * CraftingTable's records for this run is named with what it holds, by its full path.
 */
function filesSection(input: BriefInput): string {
  const lines: string[] = ['## Files to read', ''];
  const documents = input.planDocuments;
  if (documents.length) {
    const named =
      documents.length <= NAMED_PLAN_DOCUMENTS
        ? documents
        : documents.filter((d) => d.role !== 'supporting');
    const supporting = documents.length - named.length;
    const listed = [
      ...named.map((d) => `${d.role.replaceAll('-', ' ')} \`${d.filename}\``),
      ...(supporting ? [`${supporting} supporting documents (list the directory)`] : []),
    ];
    lines.push(
      `The plan bundle this work item came from is read-only in \`${input.planDirectory ?? documents[0]!.path.replace(/\/[^/]*$/, '')}/\`: ${listed.join(', ')}. ${
        input.planFinalization
          ? 'Read the entire plan and work-item inventory before starting.'
          : 'Read the parts that concern this work item before starting.'
      }`,
    );
  }
  const records = [
    ...(input.records ?? []).map((r) => `- \`${r.path}\`: ${r.about}`),
    ...(input.directories ?? []).map(
      (d) =>
        `- \`${d.path}/\`: ${d.files.map((f) => `\`${d.path.replace(/^.*\//, '')}/${f}\``).join(', ')}; ${d.about}`,
    ),
  ];
  if (records.length) {
    if (documents.length) lines.push('');
    lines.push("CraftingTable's records for this run:", ...records);
  }
  for (const paragraph of handoffParagraphs(input.parentRun, !!input.planFinalization))
    lines.push(...(lines.length > 2 ? [''] : []), paragraph);
  if (input.repositoryPolicyGuidance) lines.push('', input.repositoryPolicyGuidance);
  return lines.length > 2 ? lines.join('\n') : '';
}

export function composeBrief(input: BriefInput): string {
  const workItem = input.executionScope
    ? {
        ...input.workItem,
        sourceId: input.executionScope.identity.sourceId,
        title: input.executionScope.title,
      }
    : input.workItem;
  const sections: string[] = [];
  sections.push(
    input.planFinalization
      ? `# Plan finalization: ${workItem.title}`
      : `# Work item ${workItem.sourceId}: ${workItem.title}`,
  );
  sections.push(`Project: ${input.projectName}\nRole: ${input.role}`);
  // The five parts (AGT-50): the task; where the agent is; what it is and must return; the
  // files to read; then the controller's step rules and the operator's own words.
  sections.push(goalSection(input), whereSection(input));
  const environment = environmentSection(input.environment);
  if (environment) sections.push(environment);
  const instructions = instructionsFor(input);
  sections.push(
    [`## Your role\n\n${instructions.role}`, ...instructions.rules].join('\n\n'),
    finalMessageSection(instructions),
  );
  const files = filesSection(input);
  if (files) sections.push(files);
  sections.push(
    ...parentSections(input.parentRun, {
      role: input.role,
      resolvingIntegration: !!input.resolvingIntegration,
      planFinalization: !!input.planFinalization,
      remediationInstructions: REMEDIATION_INSTRUCTIONS,
      acceptedDesignInstructions: ACCEPTED_DESIGN_INSTRUCTIONS,
    }),
  );
  if (input.controllerInstructions?.trim()) {
    sections.push(`## Step rules (from the controller)\n\n${input.controllerInstructions.trim()}`);
  }
  if (input.instructions !== undefined && input.instructions.trim().length > 0) {
    sections.push(`## Operator instructions\n\n${input.instructions.trim()}`);
  }
  if (input.stepGuidance?.trim()) {
    sections.push(`## Operator guidance for this step\n\n${input.stepGuidance.trim()}`);
  }
  if (input.reviewContinuationArtifacts !== undefined) {
    sections.push(
      [
        '## Continue interrupted verification on the pinned review baseline',
        'The daemon confirmed the original candidate and destination commits, managed branch and worktree version are unchanged, with no tracked edits or pending Git operation. This is completion of the same review, not approval of the previous incomplete outcome.',
        `Untracked paths present at continuation preflight: ${JSON.stringify(input.reviewContinuationArtifacts)}. These are candidates for inspection, not a declaration that they are disposable.`,
        'Before rerunning verification, inspect these paths and the previous run logs and test code. For a file you can positively attribute to that interrupted verification, preserve its contents in the provided scratch directory and record its original path and why it was generated, then remove only that confirmed temporary file from the worktree. Do not stage or commit it. Do not alter tracked files or delete unknown files. If provenance is uncertain or a source change is needed, preserve the file, report an open question or finding, and stop for the appropriate remediation.',
        'Reuse only complete passing check records whose source/destination commits and relevant inputs still match. Resume missing or interrupted checks and investigate failures. Await all background work, restore a clean worktree by removing only your confirmed temporary artifacts, and return the complete consolidated review report and required Open questions checkpoint. Cleanliness, independent findings and exact-commit merge gates still apply.',
      ].join('\n\n'),
    );
  }
  if (input.reviewReportRetry) {
    sections.push(
      [
        '## Correct the rejected review report',
        `The preceding report was rejected: ${input.reviewReportRetry.issues.join(' ')}`,
        'Read its complete final message and reconcile all its findings, including new findings and dispositions not yet accepted by the controller. Return a corrected, concise report using the current findings-continuity rules; do not append prior evidence or repeat unchanged closed findings. Retain the required Open questions section and matching final VERDICT line.',
        input.reviewReportRetry.reuseVerification
          ? 'The daemon confirmed that the preceding successful, untruncated review recorded the same candidate and destination commits. Recheck those commits and worktree cleanliness. Where its findings and verification evidence are complete and applicable, reuse them with explicit references; do not rerun the whole suite solely to repair report formatting. Perform any additional investigation needed to resolve substantive uncertainty. If either commit or relevant verification conditions changed, perform a fresh review and rerun affected checks.'
          : 'The prior review is incomplete or its candidate/destination snapshot cannot be reused. Perform a fresh review and run the required verification; do not carry its approval forward.',
        'This recovery instruction applies only to this attempt. Later polish and independent review steps follow their normal verification requirements.',
      ].join('\n\n'),
    );
  }
  return `${sections.join('\n\n')}\n`;
}

/** Which source each upstream link was supplied from, and the transition that decided it (ADR-069). */
function upstreamSources(dependencies: readonly BriefUpstreamSource[]): string {
  if (!dependencies.length) return 'Upstream sources: none supplied for this scope.';
  const line = (d: BriefUpstreamSource) =>
    `- ${d.alias}: ${d.purpose === 'current-upstream' ? 'current pin' : 'historical development source'} ${d.commitSha.slice(0, 12)}${d.transition ? ` (moves to the current pin at ${d.transition.slice}${d.transition.recordId ? `, declared by operator record ${d.transition.recordId}` : ', declared in the map'})` : ''}`;
  return `Upstream sources, chosen per link by the roadmap's declared transitions:\n${dependencies.map(line).join('\n')}\nBuild against exactly these sources. A link on its current pin already moved in this tree's history; do not revert it to a historical version.`;
}

/**
 * The run's build environment, from what the daemon prepared (R-F2 part 6, AGT-55): the pinned
 * Cargo environment and its policy, a check-only run's adopted checks, the historical baseline.
 * Text about Kata appears only for a scope with Kata cases, and nothing names a toolchain
 * version the daemon does not know.
 */
function environmentSection(environment: BriefEnvironment | undefined): string {
  if (!environment) return '';
  const parts: string[] = [];
  const pinned = environment.pinned;
  if (pinned) {
    const bin = pinned.binDirectory;
    parts.push(
      [
        `Pinned dependency environment: ${pinned.manifestPath}`,
        ...(pinned.nativeApprovalId
          ? [
              `Managed native verification is approved for this run (${pinned.nativeApprovalId}). Execute applicable non-sensitive repository fixtures using ${bin}/ct-native -- <executable> <arguments>. It provides a fresh HOME/TMPDIR and bounded user service (4 CPUs, 8 GiB, 512 tasks, at most 30 minutes). Retained receipts bind exact clean candidate, dependency manifest, environment approval and logs. Use supplied Cargo for dependency-bearing checks. ct-check/ct-act and inherited implementation results cannot substitute for native verification. Do not use live service credentials${pinned.kata ? ' or claim Kata observations' : ''}; report every scope requirement independently. This is cooperative native execution under the existing OS-user trust model, not a hostile-code sandbox.`,
            ]
          : []),
        `Verification policy: ${pinned.verification.mode}. ${pinned.verification.reason}`,
        upstreamSources(pinned.dependencies),
        `Use the controller Cargo launcher ${bin}/cargo for Cargo checks (also supplied on PATH). Do not override supplied sources or use a neighboring checkout. CraftingTable runs its builds and tests, and ct-check/ct-act/ct-native, itself and relays the output; builds and checks run without network, so run cargo fetch first when dependencies must be downloaded. Builds and checks CraftingTable runs for you (the Cargo launcher's builds, ct-check, ct-act, ct-native) use a build directory CraftingTable chooses, and the launcher's other Cargo commands use the manifest's (the run’s scratch/target), whatever CARGO_TARGET_DIR says; that is expected, and receipts do not depend on it. Do not edit the manifest or override the build directory (--target-dir or CARGO_TARGET_DIR) for them.`,
        'The launcher also supports supplementary checks whose resolved graph contains no upstream packages, such as independent foundation/contract manifests within an integration run. Use the same launcher and ct-check normally; no explicit-config bypass or artificial upstream dependency is needed. Their supplementary-check receipts cannot satisfy the current-upstream build requirement.',
        pinned.verification.mode === 'scoped-checks'
          ? `Use ${bin}/ct-check -- <executable> <arguments> to retain repository-owned contract, inventory, fixture or domain test evidence. Use ${bin}/ct-act -W .github/workflows/<file>.yml -j <job> for local GitHub Actions execution; CI is supplemental and does not count as the scoped check. ${pinned.adoptedChecks ? 'The adopted checks below are required on the exact clean reviewed commit' : 'A successful ct-check or supplied Cargo check on the exact clean reviewed commit is required'}, together with independent evidence for EVERY scope obligation. Any prepared historical dependency commits are development inputs only. Do not port upstream code or align the workspace to current pins beyond the upstream links supplied as current pins above merely to satisfy this slice. Document known baseline failures separately; new scope checks must pass.`
          : `A successful Cargo build/test using current exact pins is required before merge/acceptance${pinned.adoptedChecks ? ', with the adopted checks below' : ''}. Other ct-check and ct-act logs supplement but never replace that receipt. Align constraints only within the approved integration scope.`,
        `${pinned.declaredChecks}Local CI: ${pinned.localCiImage ? `configured with image ${pinned.localCiImage}. Workflows receive CRAFTINGTABLE_DEPENDENCY_MANIFEST, CRAFTINGTABLE_CARGO_CONFIG, CRAFTINGTABLE_VERIFICATION_MODE and CRAFTINGTABLE_CI_ARTIFACTS_DIR. Use the supplied Cargo config explicitly in CI scripts (cargo --config "$CRAFTINGTABLE_CARGO_CONFIG" ...); all supplied paths are mounted into the runner. Repository workflows must select suitable checks for this scope; do not run the legacy whole-runtime workflow merely because it already exists.` : 'not configured; use ct-check and the supplied Cargo launcher for local checks.'} CI receipts do not establish external native${pinned.kata ? '/Kata' : ''} qualification. Repository workflows and scripts remain repository-owned; selecting a narrow job never waives other scope obligations.`,
      ].join('\n'),
    );
  } else if (environment.checkOnly) parts.push(environment.checkOnly.trimEnd());
  const historical = environment.historical;
  if (historical)
    parts.push(
      [
        'Controller-prepared historical baseline (characterization only):',
        `Manifest: ${historical.manifestPath}`,
        `Historical workspace: ${historical.workspacePath}`,
        `Historical Cargo: ${historical.launcher}`,
        `Command receipts: ${historical.receiptPath}`,
        "Use this separate launcher ONLY to collect the historical baseline. It uses original lockfiles and historical sibling sources, not current upstream pins. For candidate checks, follow the scope verification policy above and use the normal controller Cargo launcher. Reuse recorded historical evidence with matching source identities; collect missing baseline build/test or recovery/benchmark evidence only when required by the plan, within this run's deadline. Record exact failures and missing prerequisites. Do not port historical code, change dependencies/lockfiles or fabricate results. Preserve summaries, measurements and non-Cargo logs under historical-evidence (outside disposable scratch). Do not ask the operator to provision ordinary worktrees or these already supplied sources. Historical results never satisfy current-runtime build gates. Genuine architectural/implementation decisions remain the operator's authority; collected facts do not authorize deviations.",
      ].join('\n'),
    );
  return parts.length ? `## Build environment\n\n${parts.join('\n\n')}` : '';
}
