import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import {
  type AgentRunId,
  type AgentSelection,
  agentSelections,
  type CycleInvestigation as Investigation,
  selectionsForPurpose,
  type WorkCycle,
} from '@craftingtable/domain';
import { useState } from 'react';
import { About } from '../../components/About.js';
import { AgentSelectionFields } from '../../features/execution/AgentSelectionFields.js';
import {
  acknowledgeWorktreeChange,
  endInvestigation,
  startInvestigation,
} from './investigation-api.js';

type Finding = NonNullable<NonNullable<Investigation['result']>['findings']>[number];

/** The proposals as text for the stop's own answer, for the operator to edit before sending. */
export function proposedAnswers(findings: readonly Finding[]): string {
  return [
    'From the investigation (review and edit before sending):',
    '',
    ...findings.flatMap((finding, index) => [
      `${index + 1}. ${finding.question}`,
      finding.status === 'proposed'
        ? `   Proposed: ${finding.answer}${finding.sources.length ? ` (Sources: ${finding.sources.join('; ')})` : ''}`
        : `   Still open: ${finding.reason ?? 'the evidence does not settle it.'}`,
    ]),
  ].join('\n');
}

type ChangedPart = NonNullable<
  NonNullable<Investigation['result']>['worktreeChange']
>['parts'][number];
const CHANGED_PART: Record<ChangedPart, string> = {
  head: 'its commit',
  branch: 'its branch',
  tracked: 'tracked files',
  untracked: 'untracked files',
  ignored: 'ignored files',
  git: 'the repository’s config, hooks or info files (which its other checkouts share)',
  unreadable: 'it could not be read',
};

const OUTCOME: Record<NonNullable<Investigation['result']>['outcome'], string> = {
  finished: 'The investigation finished.',
  failed: 'The investigation failed.',
  cancelled: 'The investigation was ended.',
  interrupted: 'The investigation was interrupted.',
};

/**
 * A question stop's read-only investigation (R-C16): start one, follow or end it while it runs,
 * and read what it found. It proposes; the operator answers with the stop's own control, which
 * Use proposed answers fills for editing. Nothing is sent until the operator submits it.
 */
export function CycleInvestigation({
  cycle,
  backends,
  csrfToken,
  disabled,
  onChanged,
  onOpenRun,
  onUseAnswers,
  proposalsAdded = false,
}: {
  cycle: WorkCycle;
  backends: ExecutionStatusResponse['backends'];
  csrfToken: string;
  disabled: boolean;
  onChanged: () => void;
  onOpenRun: (id: AgentRunId) => void;
  /** Adds the proposals to the stop's answer; absent where no form takes one. */
  onUseAnswers?: (text: string) => void;
  /** This investigation's proposals are already in the stop's answer. */
  proposalsAdded?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const actions = cycle.actions ?? [];
  const record = cycle.investigation;
  // The record says whether it runs; the daemon offers only End while it does.
  const live = !!record && !record.result;
  const offered = actions.includes('investigate');
  if (!record && !offered && !live) return null;
  const run = async (command: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await command();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The investigation command failed.');
    } finally {
      setBusy(false);
    }
  };
  const locked = disabled || busy;
  const result = record?.result;
  const findings = result?.findings ?? [];
  const used = proposalsAdded;
  // The worktree changed while it ran (R-C16): its proposals are shown, never offered for use,
  // since the tree they cite changed under them; the stop waits for an acknowledgement.
  const changed = result?.code === 'worktree-changed';
  const change = changed ? result.worktreeChange : undefined;
  return (
    <section aria-label="Investigation" className="stack">
      <h3>Investigation</h3>
      {live && record && (
        <>
          <p role="status">
            {record.endRequestedAt
              ? 'Ending: the investigation run was asked to end; its result follows once its process has exited and the worktree is compared.'
              : Date.parse(record.deadlineAt) > Date.now()
                ? `Investigating: a read-only run is gathering evidence for these questions, until ${new Date(record.deadlineAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`
                : 'Investigating: the run has passed its time limit and is being ended.'}{' '}
            The stop’s other controls wait for it.
          </p>
          <p className="inline-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => onOpenRun(record.runId)}
            >
              Open investigation run
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={locked}
              onClick={() => void run(() => endInvestigation(cycle, csrfToken))}
            >
              End investigation
            </button>
          </p>
        </>
      )}
      {record && result && changed && change && (
        <>
          <p role={actions.includes('acknowledge-worktree-change') ? 'alert' : undefined}>
            The worktree changed while the investigation ran:{' '}
            {change.parts.map((part) => CHANGED_PART[part]).join(', ')}
            {change.headAfter && change.headAfter !== change.headBefore
              ? ` (HEAD ${change.headBefore.slice(0, 12)} → ${change.headAfter.slice(0, 12)})`
              : ''}
            . The change may be the agent’s or anyone’s; nothing was reset.
          </p>
          {change.paths.length > 0 && (
            <p>
              Now differing from HEAD:{' '}
              {change.paths.map((path, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list; paths may repeat.
                <span key={index}>
                  {index > 0 ? ', ' : ''}
                  <code>{path}</code>
                </span>
              ))}
            </p>
          )}
          <p role="status">
            {result.restoredAt
              ? 'The worktree matches its record again; the stop takes its commands.'
              : result.acknowledgedAt
                ? 'You acknowledged the change; the stop takes its commands.'
                : 'Inspect the worktree, then acknowledge the change. Until then the stop takes no answer.'}
          </p>
          {actions.includes('acknowledge-worktree-change') && (
            <p className="inline-actions">
              <button
                type="button"
                className="primary-button"
                disabled={locked}
                onClick={() => void run(() => acknowledgeWorktreeChange(cycle, csrfToken))}
              >
                Acknowledge the change
              </button>
            </p>
          )}
        </>
      )}
      {record && result && (
        <>
          <p>
            {changed
              ? findings.length
                ? 'Its proposals are shown below, not offered to use: they were gathered while the tree changed.'
                : OUTCOME[result.outcome]
              : findings.length
                ? `${OUTCOME.finished} ${findings.filter((f) => f.status === 'proposed').length} proposed, ${findings.filter((f) => f.status === 'open').length} still open.`
                : OUTCOME[result.outcome]}
            {result.message ? ` ${result.message}` : ''}
          </p>
          {findings.length > 0 && (
            <ol className="stack">
              {findings.map((finding, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: findings are a fixed list; questions may repeat.
                <li key={index}>
                  <strong>{finding.question}</strong>
                  {finding.status === 'proposed' ? (
                    <>
                      <p>{finding.answer}</p>
                      <ul>
                        {finding.sources.map((source, index) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list; sources may repeat.
                          <li key={index}>
                            <code>{source}</code>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p>
                      Still open: <span>{finding.reason}</span>
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
          <p className="inline-actions">
            {findings.length > 0 && onUseAnswers && !changed && (
              <button
                type="button"
                className="primary-button"
                disabled={locked || used}
                onClick={() => {
                  onUseAnswers(proposedAnswers(findings));
                }}
              >
                Use proposed answers
              </button>
            )}
            <button
              type="button"
              className="secondary-button"
              onClick={() => onOpenRun(record.runId)}
            >
              Open investigation run
            </button>
          </p>
          {used && <p role="status">Added to your answer below. Edit it before you send it.</p>}
          {!changed && record.worktree?.metadataOnly ? (
            <p>
              The worktree was checked as unchanged; {record.worktree.metadataOnly} large{' '}
              {record.worktree.metadataOnly === 1 ? 'file was' : 'files were'} compared by size and
              modification time only.
            </p>
          ) : null}
        </>
      )}
      {offered && !live && (
        <InvestigateForm
          key={`${cycle.id}:${cycle.version}`}
          cycle={cycle}
          {...(record ? { previous: record } : {})}
          backends={backends}
          disabled={locked}
          onStart={(input) => void run(() => startInvestigation(cycle, input, csrfToken))}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function InvestigateForm({
  cycle,
  previous,
  backends,
  disabled,
  onStart,
}: {
  cycle: WorkCycle;
  /** The last investigation of this stop: another try starts from what it asked. */
  previous?: Investigation;
  backends: ExecutionStatusResponse['backends'];
  disabled: boolean;
  onStart: (input: { instructions: string; minutes: number; profile: AgentSelection }) => void;
}) {
  const [instructions, setInstructions] = useState(previous?.instructions ?? '');
  const [minutes, setMinutes] = useState(previous?.minutes ?? 30);
  const [profile, setProfile] = useState<AgentSelection>(
    () =>
      previous?.profile ??
      selectionsForPurpose(
        cycle.nextAgentSelections ?? agentSelections(cycle.profiles),
        'investigation',
      ),
  );
  const backend = backends.find((b) => b.kind === profile.backend);
  const available = backend?.available === true;
  const valid = Number.isInteger(minutes) && minutes >= 5 && minutes <= 60 && available;
  return (
    <form
      aria-label="Investigate these questions"
      className="stack-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && valid) onStart({ instructions: instructions.trim(), minutes, profile });
      }}
    >
      <h4>Investigate these questions</h4>
      <About label="About investigations">
        <p>
          A read-only agent reads the worktree, the run that asked, and the branch, and proposes an
          answer to each question with its sources. It changes nothing and decides nothing; you
          answer with the stop’s own control.
        </p>
      </About>
      <label className="field">
        What to look into (optional)
        <textarea
          rows={3}
          maxLength={8000}
          value={instructions}
          disabled={disabled}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <label className="field">
        Time limit (minutes)
        <input
          type="number"
          min={5}
          max={60}
          step={1}
          required
          value={Number.isNaN(minutes) ? '' : minutes}
          disabled={disabled}
          onChange={(event) => setMinutes(event.target.valueAsNumber)}
        />
      </label>
      <p>
        Agent: {backend?.label ?? profile.backend} · {profile.model || 'Backend default'}
        {available ? '' : ' (unavailable on this workstation; choose another below)'}
      </p>
      <About label="About the investigation agent">
        <p>
          It uses the cycle’s Evidence investigation profile unless you choose another here. It
          holds the worktree while it runs, uses no remediation round, and ends after one report.
        </p>
        <AgentSelectionFields
          value={profile}
          backends={backends}
          disabled={disabled}
          onChange={setProfile}
        />
      </About>
      <button type="submit" className="secondary-button" disabled={disabled || !valid}>
        Start investigation
      </button>
    </form>
  );
}
