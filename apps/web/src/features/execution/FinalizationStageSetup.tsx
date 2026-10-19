import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import {
  type AgentProfile,
  DEFAULT_COMPLETION_POLICY,
  type EffectiveAgent,
  FINALIZATION_STAGE_KINDS,
  FINALIZATION_STAGE_LABELS,
  stageStoppingRule,
} from '@craftingtable/domain';
import { useState } from 'react';
import { AgentProfileFields } from './AgentProfileFields.js';
import { EffectiveAgentText } from './EffectiveAgentText.js';
import { About } from '../../components/About.js';
import type { FinalizationStart } from '../../lib/finalization-api.js';

type Stages = NonNullable<FinalizationStart['stages']>;
export function defaultFinalizationStages(
  review: FinalizationStart['finalReview'],
  implement: FinalizationStart['finalReview'],
  /** The minutes per step each stage starts with: the workspace's default (R-C17 part 4). */
  maxRunMinutes: number = DEFAULT_COMPLETION_POLICY.maxRunMinutes,
): Stages {
  return FINALIZATION_STAGE_KINDS.map((kind) => ({
    id: kind,
    kind,
    name: FINALIZATION_STAGE_LABELS[kind],
    workItemSourceIds: [],
    instructions: '',
    review,
    implement,
    policy: { ...DEFAULT_COMPLETION_POLICY, maxNits: 0, maxRunMinutes },
    requiredChecks: [],
  }));
}

export function FinalizationStageSetup({
  stages,
  onChange,
  backends,
  disabled,
  defaults,
}: {
  /** The workspace defaults a stage starts from, as the daemon reports them (E5-3). */
  defaults?: { readonly review: EffectiveAgent; readonly implement: EffectiveAgent };
  stages: Stages;
  onChange: (stages: Stages) => void;
  backends: ExecutionStatusResponse['backends'];
  disabled: boolean;
}) {
  const update = (index: number, changes: Partial<Stages[number]>) =>
    onChange(stages.map((s, i) => (i === index ? { ...s, ...changes } : s)));
  return (
    <section className="stack-form" aria-label="Finalization stage setup">
      <About label="About finalization stages">
        <p>
          Each stage has its own agents, instructions and remediation allowance. Simplification and
          polish discover ideas once, then pause for your batch selection. Required findings, checks
          and questions always remain gates.
        </p>
        <p>
          You can add attempts at a recovery checkpoint. Reopening a stage retains its used count
          and allowance. Optional suggestions are selected or retained as follow-up work; a nit
          allowance never excuses correctness or conformance issues.
        </p>
      </About>
      {stages.map((stage, index) => {
        const wholePlan =
          ['correctness', 'conformance', 'final-review'].includes(stage.kind) &&
          stages.findLastIndex((s) => s.kind === stage.kind) === index;
        return (
          <details key={stage.id} className="disclosure">
            <summary>
              {index + 1}. {stage.name} ·{' '}
              {stage.workItemSourceIds.length
                ? `${stage.workItemSourceIds.length} work items`
                : 'whole plan'}
            </summary>
            <div className="disclosure-body stack-form">
              <p>{stageStoppingRule(stage.kind)}</p>
              <label className="field">
                Stage name
                <input
                  required
                  maxLength={200}
                  value={stage.name}
                  disabled={disabled}
                  onChange={(e) => update(index, { name: e.target.value })}
                />
              </label>
              {!wholePlan && (
                <SourceIdsInput
                  value={stage.workItemSourceIds}
                  disabled={disabled}
                  onChange={(workItemSourceIds) => update(index, { workItemSourceIds })}
                />
              )}
              {wholePlan && (
                <p className="hint">
                  This stage covers the whole plan and interactions across subsystem boundaries.
                </p>
              )}
              <StageAgent
                label="Stage reviewer"
                inherited={defaults?.review}
                value={stage.review}
                onChange={(review) => update(index, { review })}
                backends={backends}
                disabled={disabled}
              />
              <StageAgent
                label="Stage implementation agent"
                inherited={defaults?.implement}
                value={stage.implement}
                onChange={(implement) => update(index, { implement })}
                backends={backends}
                disabled={disabled}
              />
              {(stage.kind === 'simplification' || stage.kind === 'polish') && (
                <>
                  <label className="field">
                    Optional findings
                    <select
                      value={stage.optionalFindings ?? 'select'}
                      disabled={disabled}
                      onChange={(e) =>
                        update(index, {
                          optionalFindings:
                            e.target.value === 'follow-up' ? 'follow-up' : undefined,
                        })
                      }
                    >
                      <option value="select">Choose a batch at a checkpoint</option>
                      <option value="follow-up">Keep them all as follow-up work</option>
                    </select>
                  </label>
                  <p className="hint">
                    Follow-up work skips the batch selection stop (R-C7 D6); required findings,
                    checks and questions still hold the stage.
                  </p>
                </>
              )}
              <label className="field">
                Stage instructions
                <textarea
                  value={stage.instructions}
                  maxLength={16000}
                  disabled={disabled}
                  onChange={(e) => update(index, { instructions: e.target.value })}
                />
              </label>
              <label className="field">
                Required check names (one per line)
                <textarea
                  value={stage.requiredChecks.join('\n')}
                  disabled={disabled}
                  onChange={(e) => update(index, { requiredChecks: e.target.value.split('\n') })}
                />
              </label>
              <p className="hint">
                Name additional checks to track explicitly. Repository-required checks still apply;
                the final independent review must run the full suite.
              </p>
              {(
                [
                  ['maxRemediationRounds', 'Stage remediation budget', 0, 20],
                  ['maxRunMinutes', 'Stage minutes per run', 1, 1440],
                ] as const
              ).map(([key, label, min, max]) => (
                <label className="field" key={key}>
                  {label}
                  <input
                    type="number"
                    required
                    min={min}
                    max={max}
                    value={stage.policy[key]}
                    disabled={disabled}
                    onChange={(e) =>
                      update(index, { policy: { ...stage.policy, [key]: Number(e.target.value) } })
                    }
                  />
                </label>
              ))}
              {(stage.kind === 'correctness' || stage.kind === 'conformance') && wholePlan && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={disabled || stages.length >= 24}
                  onClick={() =>
                    onChange([
                      ...stages.slice(0, index),
                      {
                        ...stage,
                        id: crypto.randomUUID(),
                        name: `${FINALIZATION_STAGE_LABELS[stage.kind]} subsystem slice`,
                      },
                      ...stages.slice(index),
                    ])
                  }
                >
                  Add {stage.kind} slice before whole-plan check
                </button>
              )}
              {!wholePlan && (stage.kind === 'correctness' || stage.kind === 'conformance') && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={disabled}
                  onClick={() => onChange(stages.filter((_, i) => i !== index))}
                >
                  Remove subsystem slice
                </button>
              )}
            </div>
          </details>
        );
      })}
    </section>
  );
}

const sameProfile = (profile: AgentProfile, agent: EffectiveAgent) =>
  profile.backend === agent.selection.backend &&
  profile.model === agent.selection.model &&
  profile.reasoningEffort === agent.selection.reasoningEffort &&
  profile.permissionMode === agent.permissionMode;

/**
 * One stage's agent as a per-action override (E5-3): the workspace default it inherits, with its
 * source, or the change made for this stage over it; "Change for this stage" edits it.
 */
function StageAgent({
  label,
  inherited,
  value,
  onChange,
  backends,
  disabled,
}: {
  label: string;
  inherited: EffectiveAgent | undefined;
  value: AgentProfile;
  onChange: (value: AgentProfile) => void;
  backends: ExecutionStatusResponse['backends'];
  disabled: boolean;
}) {
  const changed = !inherited || !sameProfile(value, inherited);
  // A button, not a nested disclosure: the stage itself is one (and e2e reads its summary).
  const [editing, setEditing] = useState(false);
  return (
    <div className="agent-override">
      <p>
        {label}:{' '}
        {inherited && !changed ? (
          <EffectiveAgentText agent={inherited} />
        ) : (
          <>
            <span className="mono">
              {backends.find((b) => b.kind === value.backend)?.label ?? value.backend} ·{' '}
              {value.model ?? 'backend default'}
              {value.reasoningEffort ? ` · ${value.reasoningEffort} effort` : ''}
            </span>
            {inherited && <span className="agent-source"> · changed for this stage</span>}
          </>
        )}
      </p>
      {editing ? (
        <>
          <AgentProfileFields
            label={label}
            value={value}
            onChange={onChange}
            backends={backends}
            disabled={disabled}
          />
          <div className="inline-actions">
            {inherited && changed && (
              <button
                type="button"
                className="secondary-button"
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...inherited.selection,
                    permissionMode: inherited.permissionMode ?? value.permissionMode,
                  })
                }
              >
                Use the workspace default
              </button>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={disabled}
              onClick={() => setEditing(false)}
            >
              Done
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className="secondary-button"
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          Change for this stage
        </button>
      )}
    </div>
  );
}

function SourceIdsInput({
  value,
  disabled,
  onChange,
}: {
  value: readonly string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [text, setText] = useState(value.join(', '));
  return (
    <label className="field">
      Work-item source IDs (comma separated; empty for whole plan)
      <input
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          onChange([
            ...new Set(
              e.target.value
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean),
            ),
          ]);
        }}
      />
    </label>
  );
}
