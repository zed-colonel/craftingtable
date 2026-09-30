import { createContext, type ReactNode, useContext } from 'react';

/**
 * A roadmap's setup, one checklist step at a time (R-E2's second increment). The setup page
 * selects a step; each panel's parts say which step they belong to, and on the setup page only
 * the selected step's parts render. Everywhere else (a map's page, an inbox item) nothing is
 * selected and every part shows.
 */
export const SETUP_STEPS = [
  { key: 'bindings', label: 'Plan and repository bindings' },
  { key: 'dependency', label: 'Dependency environment' },
  { key: 'verification', label: 'Verification environments' },
  { key: 'reviewers', label: 'Reviewer responsibilities and delegation' },
  { key: 'automation', label: 'Automation and agents' },
  { key: 'plan-acceptance', label: 'Plan acceptance' },
  { key: 'decisions', label: 'Shared architecture decisions' },
  { key: 'evidence', label: 'Submitted evidence and builds' },
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number]['key'];

const SelectedStep = createContext<SetupStep | undefined>(undefined);
export const SetupStepProvider = SelectedStep.Provider;

/** Hidden on the setup page unless one of its steps is selected. */
export function SetupStepPart({
  step,
  children,
}: {
  step: SetupStep | readonly SetupStep[];
  children: ReactNode;
}) {
  const selected = useContext(SelectedStep);
  const steps: readonly SetupStep[] = typeof step === 'string' ? [step] : step;
  return (
    <div data-setup-step={steps[0]} hidden={selected !== undefined && !steps.includes(selected)}>
      {children}
    </div>
  );
}

/**
 * The step a setup focus belongs to: the element an attention item, a notification or a link
 * opens. Unknown focuses belong to no step.
 */
export function stepForFocus(focus: string, roadmapId: string): SetupStep | undefined {
  const runtime = `runtime-evidence-roadmap-${roadmapId}`;
  if (focus === runtime || focus === `${runtime}-setup`) return 'dependency';
  const sections: readonly (readonly [string, SetupStep])[] = [
    [`${runtime}-native`, 'verification'],
    [`${runtime}-plan-acceptance`, 'plan-acceptance'],
    [`${runtime}-decisions`, 'decisions'],
    [`${runtime}-evidence`, 'evidence'],
    [`roadmap-setup-${roadmapId}-bindings`, 'bindings'],
    [`map-adoption-roadmap-${roadmapId}`, 'bindings'],
    [`map-reviewers-roadmap-${roadmapId}`, 'reviewers'],
    [`future-delegation-${roadmapId}`, 'reviewers'],
    [`scope-recovery-${roadmapId}`, 'reviewers'],
    [`map-settings-roadmap-${roadmapId}`, 'automation'],
    [`decision-preparation-${roadmapId}`, 'decisions'],
  ];
  return sections.find(([id]) => focus === id)?.[1];
}

/** The step an open attention item's path opens on setup, if it points there. */
export function stepForPath(path: string, roadmapId: string): SetupStep | undefined {
  const match = /\/roadmaps\/([^/#?]+)\/setup#(.+)$/.exec(path);
  if (!match || decodeURIComponent(match[1] ?? '') !== roadmapId) return undefined;
  return stepForFocus(decodeURIComponent(match[2] ?? ''), roadmapId);
}
