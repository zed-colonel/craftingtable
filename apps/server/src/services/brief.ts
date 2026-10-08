import type { AgentRunRole, JsonValue, ReviewBranchContext, WorkItem } from '@craftingtable/domain';
import { designInstructions, investigationInstructions } from './brief-design.js';
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
import type { HandoffFiles } from './run-handoff.js';

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

export interface BriefInput {
  readonly repositoryPolicyGuidance?: string;
  readonly executionScope?: {
    readonly identity: import('@craftingtable/domain').ExecutionScope;
    readonly title: string;
    readonly scope: string;
    readonly excludes: readonly string[];
    readonly requirements: readonly string[];
    readonly cases: readonly string[];
    readonly context: string;
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
  readonly planDocuments: readonly BriefPlanDocument[];
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

export interface BriefParentRun {
  readonly role: AgentRunRole;
  readonly verdict?: 'mergeable' | 'changes-requested';
  /** The parent's final message: a review's findings, an implementation's summary. */
  readonly finalMessage: string;
  readonly handoff?: Omit<HandoffFiles, 'sources'>;
}

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
  if (entries.length === 0) {
    return '- none';
  }
  return entries.map((entry) => `- ${entry.sourceId}: ${entry.title} (${entry.status})`).join('\n');
}

function formatSourceFields(value: JsonValue): string {
  const serialized = JSON.stringify(value, null, 2) ?? 'null';
  return serialized.length > 20_000 ? `${serialized.slice(0, 20_000)}\n…(truncated)` : serialized;
}

export function composeBrief(input: BriefInput): string {
  const workItem = input.executionScope
    ? {
        ...input.workItem,
        sourceId: input.executionScope.identity.sourceId,
        title: input.executionScope.title,
        exitGate: input.executionScope.scope,
      }
    : input.workItem;
  const { worktree } = input;
  const sections: string[] = [];
  sections.push(
    input.planFinalization
      ? `# Plan finalization: ${workItem.title}`
      : `# Work item ${workItem.sourceId}: ${workItem.title}`,
  );
  sections.push(`Project: ${input.projectName}\nRole: ${input.role}`);
  if (input.repositoryPolicyGuidance)
    sections.push(
      `## Repository policy and operator decisions\n\n${input.repositoryPolicyGuidance}`,
    );
  if (input.executionScope) {
    const s = input.executionScope;
    sections.push(
      `## Controller-owned execution scope\n\nThis run covers only ${s.identity.sourceId}. The parent exit gate remains: ${input.workItem.exitGate}. Do not implement excluded work or mark the parent complete. If new requirements or dependencies are needed, report them as open questions and propose a planning amendment with its rationale and affected scopes. Do not silently change the plan, map, acceptance criteria or scheduling authority during remediation.\nScope: ${s.scope}\nExclusions:\n${s.excludes.map((e) => `- ${e}`).join('\n') || '- none'}\n${s.context}\nEvidence obligations:\n${s.requirements.map((e) => `- ${e}`).join('\n')}\nAssigned cases: ${s.cases.join(', ') || 'none'}`,
    );
  }
  const instructions = instructionsFor(input);
  sections.push(
    [`## Your role\n\n${instructions.role}`, ...instructions.rules].join('\n\n'),
    finalMessageSection(instructions),
  );
  sections.push(
    [
      '## Objective and exit gate',
      '',
      `Exit gate: ${workItem.exitGate}`,
      '',
      `Risk: ${workItem.risk}${workItem.phase === undefined ? '' : `\nPhase: ${workItem.phase}`}`,
      `Primary areas: ${workItem.primaryAreas.length === 0 ? 'unspecified' : workItem.primaryAreas.join(', ')}`,
    ].join('\n'),
  );
  sections.push(
    [
      '## Dependencies',
      '',
      input.executionScope
        ? 'Original parent predecessors (slice readiness is defined by the controller scope and evidence ledger):'
        : 'Required predecessors:',
      formatDependencies(input.requiredDependencies),
      '',
      'Recommended predecessors:',
      formatDependencies(input.recommendedDependencies),
    ].join('\n'),
  );
  sections.push(
    [
      '## Working environment',
      '',
      `You are in a dedicated Git worktree at \`${worktree.path}\` on branch \`${worktree.branchName}\`,`,
      `created from \`${worktree.baseBranch}\` at \`${worktree.baseSha}\`.`,
      'This is the only place you may change files. The primary checkout and other worktrees',
      'of this repository are off limits.',
    ].join('\n'),
  );
  if (worktree.integrationBranch !== undefined) {
    sections.push(
      `Integration destination: ${worktree.integrationBranch}. Only the daemon may merge into it under the operator’s approval or recorded integration policy.`,
    );
  }
  if (input.reviewBranchContext !== undefined) {
    const context = input.reviewBranchContext;
    sections.push(
      `Review baseline: item commit ${context.headSha}; integration branch ${context.targetBranch} at ${context.targetSha}. Verify this combined state and report the checks you ran. Do not move either branch during review.`,
    );
  }
  if (input.temporaryDirectory) {
    sections.push(
      [
        '## Temporary files',
        `TMPDIR, TMP, and TEMP point to ${input.temporaryDirectory}. Use this controller-owned directory for test temporary files and scratch output. It is outside the Git worktree and available to this run. Do not redirect temporary files to the worktree root. Do not commit test artifacts. Preserve verification results in your final message. ${
          !input.cargo
            ? ''
            : input.buildCacheDirectory
              ? `CARGO_TARGET_DIR points to ${input.buildCacheDirectory}, this worktree’s build cache. Earlier steps in this worktree built into it, so builds are incremental; keep build outputs there rather than creating another target directory, and do not put evidence inside it. It is removed when the worktree is merged or removed.${input.environment?.pinned ? ' The supplied Cargo launcher and CraftingTable’s checks use their own build directories instead (see the build environment below).' : ''} `
              : 'CARGO_TARGET_DIR points to this run’s scratch/target build cache. Keep build outputs there and do not put evidence inside a build cache. Recognized build caches are disposable and may be removed when this run ends, including failed or cancelled runs. '
        }Verification logs and reports belong in separate scratch/verification or scratch/review directories. Other scratch may expire under the storage policy, and source edits remain restricted to the worktree; this directory is for temporary data only.`,
      ].join('\n\n'),
    );
  }
  if (input.planDocuments.length > 0) {
    sections.push(
      [
        '## Plan documents',
        '',
        'The plan bundle this work item came from is available read-only at these paths.',
        input.planFinalization
          ? 'Read the entire plan and work-item inventory before starting.'
          : 'Read the parts that concern this work item before starting.',
        '',
        ...input.planDocuments.map((document) => `- ${document.role}: \`${document.path}\``),
      ].join('\n'),
    );
  }
  sections.push(
    [
      '## Source definition',
      '',
      'Every field of this work item as written in the plan:',
      '',
      '```json',
      formatSourceFields(workItem.sourceFields),
      '```',
    ].join('\n'),
  );
  const parent = input.parentRun;
  if (parent?.handoff !== undefined) {
    sections.push(
      [
        '## Handoff source files',
        '',
        input.planFinalization
          ? `Start with the handoff manifest at \`${parent.handoff.manifestPath}\`, the active findings snapshot and the immediate parent's complete outcome. Consult source conversations for operator decisions, corrections, uncertain observations and evidence; older reports are history, not text to reproduce.`
          : `Read the handoff manifest at \`${parent.handoff.manifestPath}\` and the conversation and report files it lists before starting.`,
        'These files include earlier messages, operator corrections, and prior runs in this lineage. Paths in the manifest are relative to its directory.',
        'Reports with status complete are structurally validated reviewer assertions. Unstructured or invalid reports require reconciliation against the conversation; ask the operator about unresolved ambiguity.',
        'Earlier findings may be corrected or withdrawn later. Do not treat every historical statement as a current finding. Preserve existing finding IDs across review rounds.',
        `The full recorded final message is at \`${parent.handoff.finalMessagePath}\`.`,
        ...(parent.handoff.findingsPath
          ? [
              `Active findings and closed-history index: \`${parent.handoff.findingsPath}\`. This is derived from valid reports at the delivered event cursors. Omitted closed findings retain their last reviewer disposition.`,
            ]
          : []),
        ...parent.handoff.warnings.map((warning) => `Handoff warning: ${warning}`),
      ].join('\n\n'),
    );
  }
  const parentMessage =
    input.planFinalization && parent?.handoff
      ? `Read the complete outcome at \`${parent.handoff.finalMessagePath}\`. Use the active findings snapshot; do not copy the historical report into your response.`
      : (parent?.finalMessage.trim() ?? '');
  if (
    parent !== undefined &&
    (parent.finalMessage.trim().length > 0 || parent.handoff !== undefined)
  ) {
    if (!input.resolvingIntegration && parent.role === 'review' && input.role === 'implement') {
      sections.push(`## Remediation\n\n${REMEDIATION_INSTRUCTIONS}`);
      sections.push(
        `## Review findings to address${
          parent.verdict === undefined ? '' : ` (verdict: ${parent.verdict})`
        }\n\n${parentMessage}`,
      );
    } else if (
      !input.resolvingIntegration &&
      parent.role === 'design' &&
      input.role === 'implement'
    ) {
      sections.push(`## Accepted design\n\n${ACCEPTED_DESIGN_INSTRUCTIONS}`);
      sections.push(`## Design proposal\n\n${parentMessage}`);
    } else if (parent.role === 'implement' && input.role === 'review') {
      sections.push(
        `## The implementation run's own summary\n\nTreat this as a claim to verify, not as evidence.\n\n${parentMessage}`,
      );
    } else {
      sections.push(`## Previous ${parent.role} run\n\n${parentMessage}`);
    }
  }
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
  const environment = environmentSection(input.environment);
  if (environment) sections.push(environment);
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
