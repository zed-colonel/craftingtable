import type { ExecutionStatusResponse, StartFinalizationRequest } from '@craftingtable/contracts';
import {
  DEFAULT_COMPLETION_POLICY,
  FINALIZATION_STAGE_KINDS,
  FINALIZATION_STAGE_LABELS,
  stageStoppingRule,
} from '@craftingtable/domain';
import { useState } from 'react';
import { AgentProfileFields } from './AgentProfileFields.js';

type Stages = NonNullable<StartFinalizationRequest['stages']>;
export function defaultFinalizationStages(
  review: StartFinalizationRequest['finalReview'],
  implement: StartFinalizationRequest['finalReview'],
): Stages {
  return FINALIZATION_STAGE_KINDS.map((kind) => ({
    id: kind,
    kind,
    name: FINALIZATION_STAGE_LABELS[kind],
    workItemSourceIds: [],
    instructions: '',
    review,
    implement,
    policy: { ...DEFAULT_COMPLETION_POLICY, maxNits: 0 },
    requiredChecks: [],
  }));
}

export function FinalizationStageSetup({
  stages,
  onChange,
  backends,
  disabled,
}: {
  stages: Stages;
  onChange: (stages: Stages) => void;
  backends: ExecutionStatusResponse['backends'];
  disabled: boolean;
}) {
  const update = (index: number, changes: Partial<Stages[number]>) =>
    onChange(stages.map((s, i) => (i === index ? { ...s, ...changes } : s)));
  return (
    <section className="stack-form" aria-label="Finalization stage setup">
      <p>
        Each stage has its own agents, instructions and remediation allowance. Simplification and
        polish discover ideas once, then pause for your batch selection. Required findings, checks
        and questions always remain gates.
      </p>
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
              <AgentProfileFields
                label="Stage reviewer"
                value={stage.review}
                onChange={(review) => update(index, { review })}
                backends={backends}
                disabled={disabled}
              />
              <AgentProfileFields
                label="Stage implementation agent"
                value={stage.implement}
                onChange={(implement) => update(index, { implement })}
                backends={backends}
                disabled={disabled}
              />
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
              <p className="hint">
                You can add attempts at a recovery checkpoint. Reopening a stage retains its used
                count and allowance. Optional suggestions are selected or retained as follow-up
                work; a nit allowance never excuses correctness or conformance issues.
              </p>
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

function SourceIdsInput({
  value,
  disabled,
  onChange,
}: {
  value: string[];
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
