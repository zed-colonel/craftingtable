import type { ConcurrencyDefinition } from '@craftingtable/domain';
import { subjectRequirements, testedRepositories } from './runtime-evidence-policy.js';
/** The implemented checkpoint adapter supports local, single-repository reviews only. */
export function supportsTechnicalCheckpoint(d: ConcurrencyDefinition, id: string, alias?: string) {
  const c = d.source.checkpoints.find((c) => c.id === id);
  if (!c || !['contract', 'profile', 'semantic_review'].includes(c.kind)) return false;
  const subject = { kind: 'checkpoint' as const, sourceId: id };
  const spec = subjectRequirements(d, subject),
    code = testedRepositories(d, subject);
  return (
    !spec.cases.some((c) => c.requiresKata) &&
    ((code.length === 1 && code[0] === (alias ?? c.owner)) ||
      (c.kind === 'semantic_review' && code.length === 0))
  );
}
