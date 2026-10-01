import type {
  ControlFinalizationRequest,
  ExecutionStatusResponse,
  FinalizationView,
} from '@craftingtable/contracts';
import {
  type FinalizationAgentSelection,
  finalizationProfile,
  optionalFinding,
  remediationAllowance,
  remediationUsed,
} from '@craftingtable/domain';
import { useState } from 'react';
import { finalizationViewSchema } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';
import { About } from '../../components/About.js';
import { FinalizationCheckpoint } from './FinalizationCheckpoint.js';
import { FinalizationRecoveryAgent } from './FinalizationRecoveryAgent.js';

type Props = {
  view: FinalizationView;
  busy: boolean;
  backends: ExecutionStatusResponse['backends'];
  onDecide: (input: ControlFinalizationRequest) => void;
};

const encode = encodeURIComponent;
/**
 * A staged finalization's decision (R-A6 increment 2b): the only poster of its stage, plan
 * adjustment, findings, attempts and resume decisions on `finalizations/:id/control`.
 */
function decide(
  workspaceId: WorkspaceId,
  finalizationId: string,
  input: ControlFinalizationRequest,
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encode(workspaceId)}/finalizations/${encode(finalizationId)}/control`,
    finalizationViewSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify(input),
    },
  );
}

/**
 * The next step of a staged finalization (R-A6 increment 2b): the stage's batch or the plan
 * adjustment it proposes, else the checkpoint's findings, more attempts or a resume, offering
 * only the decisions the daemon returned. It renders in the finalization's inbox item, and on
 * the plan's page when no item carries the stop.
 */
export function FinalizationStep({
  workspaceId,
  view,
  csrfToken,
  disabled,
  backends,
  onDone,
}: {
  workspaceId: WorkspaceId;
  view: FinalizationView;
  csrfToken: string;
  disabled: boolean;
  backends: ExecutionStatusResponse['backends'];
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const actions = view.actions ?? [];
  const onDecide = (input: ControlFinalizationRequest) => {
    setBusy(true);
    setError(undefined);
    void decide(workspaceId, view.finalization.id, input, csrfToken)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .then(() => onDone())
      .finally(() => setBusy(false));
  };
  const props = { view, busy: disabled || busy, backends, onDecide, actions };
  const step = actions.some((a) => a === 'select-stage-findings' || a === 'approve-plan-change') ? (
    <StageDecision {...props} />
  ) : actions.some((a) => ['remediate-findings', 'authorize-remediation', 'resume'].includes(a)) ? (
    <FinalizationCheckpoint {...props} />
  ) : undefined;
  if (!step) return null;
  return (
    <>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {step}
    </>
  );
}
function StageDecision({
  view,
  busy,
  backends,
  onDecide,
  actions,
}: Props & { actions: readonly string[] }) {
  const cycle = view.cycle;
  const progress = cycle?.finalizationProgress;
  const stage = view.finalization.stages?.[progress?.stageIndex ?? 0];
  const proposals = progress?.obligations.filter((o) => o.status === 'change-requested') ?? [];
  const choices = view.checkpointFindings.filter(
    (f) => optionalFinding(f) && f.category === stage?.kind,
  );
  const [action, setAction] = useState<'select-stage-findings' | 'approve-plan-change' | 'resume'>(
    proposals.length ? 'approve-plan-change' : 'select-stage-findings',
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [obligationId, setObligationId] = useState(proposals[0]?.id ?? '');
  const [rationale, setRationale] = useState('');
  const [instructions, setInstructions] = useState('');
  const [extra, setExtra] = useState(
    cycle && remediationUsed(cycle) >= remediationAllowance(cycle) ? 1 : 0,
  );
  const [agentMode, setAgentMode] = useState<'keep' | 'switch' | 'restore'>('keep');
  const [agent, setAgent] = useState<FinalizationAgentSelection>(() => {
    const p = cycle ? finalizationProfile(view.finalization, cycle) : view.finalization.finalReview;
    return { backend: p.backend, ...(p.model ? { model: p.model } : {}) };
  });
  if (!cycle || !progress) return null;
  const proposal = proposals.find((o) => o.id === obligationId);
  const selection = action === 'select-stage-findings';
  const used = remediationUsed(cycle);
  const allowance = remediationAllowance(cycle);
  const blocker =
    action !== 'resume' && !rationale.trim()
      ? 'Enter a rationale.'
      : action === 'approve-plan-change' && !proposal
        ? 'Select a proposed plan adjustment.'
        : selection &&
            selected.length &&
            (!Number.isInteger(extra) || extra < 0 || extra > 20 || used >= allowance + extra)
          ? 'Authorize enough additional attempts for this selected batch (0–20).'
          : agentMode === 'switch' && !backends.some((b) => b.kind === agent.backend && b.available)
            ? 'Choose an available backend.'
            : undefined;
  const label = selection
    ? selected.length
      ? 'Authorize selected stage batch'
      : 'Keep all as follow-up and continue'
    : action === 'approve-plan-change'
      ? 'Approve plan adjustment and revalidate'
      : 'Resume finalization';
  return (
    <form
      className="stack-form"
      aria-label="Finalization next step"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || blocker) return;
        onDecide({
          action,
          expectedVersion: view.finalization.version,
          expectedCycleVersion: cycle.version,
          instructions,
          ...(selection
            ? {
                selectedFindingIds: selected,
                rationale,
                ...(selected.length && extra ? { additionalRounds: extra } : {}),
              }
            : action === 'approve-plan-change'
              ? { obligationId, rationale }
              : {}),
          ...(agentMode === 'switch'
            ? { agentOverride: agent }
            : agentMode === 'restore'
              ? { agentOverride: null }
              : {}),
        });
      }}
    >
      <h4>Next finalization step</h4>
      <label className="field">
        Next action
        <select
          value={action}
          disabled={busy}
          onChange={(e) => setAction(e.target.value as typeof action)}
        >
          {!!proposals.length && actions.includes('approve-plan-change') && (
            <option value="approve-plan-change">Decide a proposed plan adjustment</option>
          )}
          {!proposals.length && actions.includes('select-stage-findings') && (
            <option value="select-stage-findings">Select this stage’s improvement batch</option>
          )}
          {actions.includes('resume') && (
            <option value="resume">Resume with answers or guidance</option>
          )}
        </select>
      </label>
      {selection && (
        <fieldset disabled={busy}>
          <legend>Optional improvements (select any or none)</legend>
          <p>
            Selected findings will be implemented and verified. Unselected ideas stay open as
            follow-up work. Verification does not restart discovery.
          </p>
          <div className="inline-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setSelected(choices.map((f) => f.id))}
            >
              Select all improvements
            </button>
            <button type="button" className="secondary-button" onClick={() => setSelected([])}>
              Clear selection
            </button>
          </div>
          {choices.map((f) => (
            <label className="checkbox-row" key={f.id}>
              <input
                type="checkbox"
                checked={selected.includes(f.id)}
                onChange={(e) =>
                  setSelected((ids) =>
                    e.target.checked ? [...ids, f.id] : ids.filter((id) => id !== f.id),
                  )
                }
              />
              <span>
                {f.id} · {f.category} · {f.severity} · {f.title}
                <br />
                {f.recommendation}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {action === 'approve-plan-change' && (
        <>
          <label className="field">
            Proposed obligation change
            <select
              value={obligationId}
              disabled={busy}
              onChange={(e) => setObligationId(e.target.value)}
            >
              {proposals.map((o) => (
                <option value={o.id} key={o.id}>
                  {o.id} · {o.source}
                </option>
              ))}
            </select>
          </label>
          {proposal && (
            <article className="review-finding">
              <p>Adopted requirement: {proposal.requirement}</p>
              <p>
                <strong>Proposed replacement:</strong> {proposal.proposedRequirement}
              </p>
              <p>{proposal.evidence}</p>
            </article>
          )}
          <p>
            Approval changes this obligation and records your rationale; a new review must verify
            it. To keep the existing requirement, resume with guidance instead.
          </p>
          <About label="About plan changes">
            <p>
              Approval changes the obligation for this finalization only. Required checks and other
              unanswered questions remain gates.
            </p>
          </About>
        </>
      )}
      {action !== 'resume' && (
        <label className="field">
          {selection ? 'Disposition rationale (required)' : 'Plan change rationale (required)'}
          <textarea
            required
            maxLength={4000}
            value={rationale}
            disabled={busy}
            onChange={(e) => setRationale(e.target.value)}
          />
        </label>
      )}
      <label className="field">
        Answers and guidance (optional)
        <textarea
          maxLength={action === 'resume' ? 16000 : 10000}
          value={instructions}
          disabled={busy}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      {selection && !!selected.length && (
        <>
          <label className="field">
            Additional stage attempts
            <input
              type="number"
              required
              min={0}
              max={20}
              value={extra}
              disabled={busy}
              onChange={(e) => setExtra(Number(e.target.value))}
            />
          </label>
          <p>
            This stage: {used} used of {allowance}. With this disposition:{' '}
            {Math.max(0, allowance + extra - used)} available attempts. Other stage budgets are
            unchanged.
          </p>
        </>
      )}
      {action === 'resume' && (
        <p>
          Resume requests a fresh review with this guidance. It does not select improvements,
          approve plan changes or add remediation attempts.
        </p>
      )}
      <FinalizationRecoveryAgent
        mode={agentMode}
        onMode={setAgentMode}
        value={agent}
        onChange={setAgent}
        current={cycle.finalizationAgentOverride}
        backends={backends}
        disabled={busy}
      />
      <p role="status">{blocker ?? (busy ? 'Submitting…' : `${label} is ready.`)}</p>
      <button type="submit" className="primary-button" disabled={busy || !!blocker}>
        {label}
      </button>
    </form>
  );
}
