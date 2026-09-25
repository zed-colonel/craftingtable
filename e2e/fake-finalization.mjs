import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A staged finalization review as the stand-in agents answer it (R-B10). The review brief
 * names the stage ledger; the answer reports the current stage's checks and obligations.
 *
 * - FINALIZATION-REMEDIATION-LIMIT in the instructions raises F-001, a correctness finding,
 *   in the correctness stage until REMEDIATED.md exists.
 * - Otherwise the simplification stage discovers optional ideas S-1 and S-2 once, then
 *   verifies S-1 (POLISH-1.md) and reports a new idea S-3.
 *
 * Returns undefined for a review that is not a staged finalization stage.
 */
export function stagedFinalizationReview(text, cwd) {
  const ledgerPath = /`([^`]+\/craftingtable-finalization-state\.json)`/.exec(text)?.[1];
  if (!ledgerPath) return undefined;
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const stage = ledger.stages[ledger.progress.stageIndex];
  const findings = [];
  if (text.includes('FINALIZATION-REMEDIATION-LIMIT')) {
    const fixed = existsSync(join(cwd, 'REMEDIATED.md'));
    if (stage.kind === 'correctness')
      findings.push({
        id: 'F-001',
        category: 'correctness',
        severity: 'nit',
        status: fixed ? 'resolved' : 'open',
        title: 'Clarify the finalization example',
        explanation: 'The example needs a short explanation.',
        recommendation: 'Clarify the example.',
        ...(fixed ? { disposition: 'Verified the explanation.' } : {}),
      });
  } else if (stage.kind === 'simplification') {
    const idea = {
      id: 'S-1',
      category: 'simplification',
      severity: 'minor',
      status: 'open',
      title: 'Simplify the fixture example',
      explanation: 'A smaller example is easier to follow.',
      recommendation: 'Simplify the example.',
    };
    findings.push(
      ...(existsSync(join(cwd, 'POLISH-1.md'))
        ? [
            { ...idea, status: 'resolved', disposition: 'Verified POLISH-1.md.' },
            { ...idea, id: 'S-3', title: 'A new optional suggestion' },
          ]
        : [idea, { ...idea, id: 'S-2', title: 'Another optional simplification' }]),
    );
  }
  return {
    findings,
    finalization: {
      stageId: stage.id,
      fullChecks: stage.kind === 'final-review',
      checks: (stage.requiredChecks.length ? stage.requiredChecks : ['Fixture checks']).map(
        (name) => ({ name, status: 'passed', evidence: 'Fixture verification passed.' }),
      ),
      obligations: ledger.progress.obligations.map((o) => ({
        id: o.id,
        status: 'met',
        evidence: 'Fixture implementation and verification.',
      })),
    },
  };
}
