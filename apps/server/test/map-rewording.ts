import { readFileSync } from 'node:fs';
import { analyzeConcurrencyArchive } from '@craftingtable/planning';
import type { ConcurrencySource } from '@craftingtable/domain';

/** The v0.3 reference map, as the importer reads it. */
export function v03Source(): ConcurrencySource {
  return analyzeConcurrencyArchive(
    readFileSync(
      new URL(
        '../../../fixtures/concurrency/cross-stack-concurrency-draft-v0.3.0-aq-baseline-alignment.zip',
        import.meta.url,
      ),
    ),
  ).source!;
}

const reword = (text: string) => `Reworded: ${text.split('').reverse().join('')}`;
const rewordAll = (texts: readonly string[]) => texts.map(reword);
/** The leading word stays: it is the maturity token R-F5's `verification_mode` replaces. */
const rewordMaturity = (text: string) => `${/^[A-Za-z]+/.exec(text)?.[0] ?? ''} (reworded note)`;

/**
 * A copy of a map with its prose reworded (R-F2 done-when (a)): every title, description and
 * note, the wording of every evidence profile except the two attested contracts, every pass
 * criterion except the plan checkpoint's, and every `source_maturity` after its leading word.
 * Ids, kinds, owners, roles and requirements are untouched.
 */
export function rewordedSource(s: ConcurrencySource): ConcurrencySource {
  const attested = new Set(['plan-approval', 'decision-review']);
  return {
    ...s,
    document: reword(s.document),
    decisions: s.decisions.map((d) => ({
      ...d,
      title: reword(d.title),
      proposed_resolution: reword(d.proposed_resolution),
      source_notes: rewordAll(d.source_notes),
    })),
    semantics: { ...s.semantics, parent_acceptance: reword(s.semantics.parent_acceptance) },
    evidence_profiles: s.evidence_profiles.map((p) =>
      attested.has(p.id) ? p : { ...p, required_evidence: rewordAll(p.required_evidence) },
    ),
    scheduling_policy: {
      ...s.scheduling_policy,
      agent_capacity: reword(s.scheduling_policy.agent_capacity),
      resource_reservations: reword(s.scheduling_policy.resource_reservations),
      required_execution_isolation: reword(s.scheduling_policy.required_execution_isolation),
      priority_hint: reword(s.scheduling_policy.priority_hint),
      feedback_is_not_dependency: reword(s.scheduling_policy.feedback_is_not_dependency),
      target_selection: reword(s.scheduling_policy.target_selection),
      resource_profile_binding: reword(s.scheduling_policy.resource_profile_binding),
    },
    resource_locks: s.resource_locks.map((l) => ({ ...l, scope: reword(l.scope) })),
    checkpoints: s.checkpoints.map((c) => ({
      ...c,
      title: reword(c.title),
      pass_criteria: c.kind === 'plan_approval' ? c.pass_criteria : rewordAll(c.pass_criteria),
    })),
    deferred_decisions: s.deferred_decisions.map((d) => ({
      ...d,
      title: reword(d.title),
      reason: reword(d.reason),
    })),
    work_items: s.work_items.map((w) => ({
      ...w,
      title: reword(w.title),
      source_maturity: rewordMaturity(w.source_maturity),
      risk: reword(w.risk),
      source_exit_gate: reword(w.source_exit_gate),
    })),
    slices: s.slices.map((x) => ({
      ...x,
      title: reword(x.title),
      scope: reword(x.scope),
      excludes: rewordAll(x.excludes),
    })),
    limitations: rewordAll(s.limitations),
    resource_profiles: s.resource_profiles.map((p) => ({
      ...p,
      description: reword(p.description),
    })),
    planning_targets: s.planning_targets.map((t) => ({ ...t, scope: reword(t.scope) })),
  };
}

/** A copy with every value exactly `from` (an id or a role, wherever it is used) renamed. */
export function renamed(s: ConcurrencySource, from: string, to: string): ConcurrencySource {
  return JSON.parse(
    JSON.stringify(s).replaceAll(JSON.stringify(from), JSON.stringify(to)),
  ) as ConcurrencySource;
}
