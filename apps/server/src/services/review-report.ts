import { reviewReportSchema } from '@craftingtable/contracts';
import type { AgentRunVerdict, ReviewReportAssessment } from '@craftingtable/domain';

export function finalVerdict(text: string): AgentRunVerdict | undefined {
  const match = /^VERDICT:\s*(mergeable|changes-requested)$/i.exec(
    text.trim().split('\n').at(-1)?.trim() ?? '',
  );
  return match?.[1]?.toLowerCase() as AgentRunVerdict | undefined;
}

export function assessReviewReport(
  text: string,
  truncated = false,
  previousFindingIds: ReadonlySet<string> = new Set(),
): ReviewReportAssessment {
  if (truncated || text.endsWith('…[truncated by CraftingTable]')) {
    return {
      status: 'invalid',
      issues: ['The final review message was truncated. Ask the reviewer for a complete report.'],
    };
  }
  const blocks = [...text.matchAll(/^```craftingtable-review\s*\r?\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length === 0 && !text.includes('```craftingtable-review')) {
    return previousFindingIds.size === 0
      ? {
          status: 'unstructured',
          issues: [
            'No structured findings report. Reconcile the recorded conversation before remediation.',
          ],
        }
      : {
          status: 'invalid',
          issues: [
            'The latest turn omitted the structured report and previously recorded findings.',
          ],
        };
  }
  if (blocks.length !== 1) {
    return {
      status: 'invalid',
      issues: ['End the review with exactly one complete craftingtable-review JSON block.'],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(blocks[0]?.[1] ?? '');
  } catch {
    return { status: 'invalid', issues: ['The findings report is not valid JSON.'] };
  }
  const parsed = reviewReportSchema.safeParse(value);
  if (!parsed.success) {
    return {
      status: 'invalid',
      issues: parsed.error.issues
        .slice(0, 20)
        .map((issue) => `${issue.path.join('.') || 'report'}: ${issue.message}`),
    };
  }
  const report = parsed.data;
  const issues: string[] = [];
  if (finalVerdict(text) !== report.verdict) {
    issues.push('The final VERDICT line must agree with the structured report.');
  }
  const ids = new Set(report.findings.map((finding) => finding.id));
  const missing = [...previousFindingIds].filter((id) => !ids.has(id));
  if (missing.length > 0) {
    issues.push(
      `Previously recorded findings are missing: ${missing.join(', ')}. Retain them, marking resolved or withdrawn findings with a disposition.`,
    );
  }
  return issues.length > 0
    ? { status: 'invalid', issues }
    : { status: 'complete', issues: [], report };
}
