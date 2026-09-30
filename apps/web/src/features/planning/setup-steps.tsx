import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { revealElement, SHOW_PART_EVENT, type ShowPart } from '../../lib/reveal-element.js';

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

/** The ids a page's setup panels carry: a roadmap's, or a map's own before any roadmap. */
export interface SetupIds {
  /** RuntimeEvidencePanel's `panelId`. */
  readonly runtime: string;
  /** CrossProjectPanel's key: `roadmap-<id>`, or the map's definition id. */
  readonly panel: string;
  readonly roadmapId?: string;
}
export const roadmapSetupIds = (roadmapId: string): SetupIds => ({
  runtime: `runtime-evidence-roadmap-${roadmapId}`,
  panel: `roadmap-${roadmapId}`,
  roadmapId,
});
export const mapSetupIds = (definitionId: string): SetupIds => ({
  runtime: `runtime-evidence-${definitionId}`,
  panel: definitionId,
});

/** The element each step's checklist entry brings into view. */
export function stepAnchors(ids: SetupIds): Record<SetupStep, string> {
  return {
    bindings: ids.roadmapId ? `roadmap-setup-${ids.roadmapId}-bindings` : `map-focus-${ids.panel}`,
    dependency: `${ids.runtime}-setup`,
    verification: `${ids.runtime}-native`,
    reviewers: `map-reviewers-${ids.panel}`,
    automation: `map-settings-${ids.panel}`,
    'plan-acceptance': `${ids.runtime}-plan-acceptance`,
    decisions: `${ids.runtime}-decisions`,
    evidence: `${ids.runtime}-evidence`,
  };
}

/**
 * The step a setup focus belongs to: the element an attention item, a notification or a link
 * opens. Unknown focuses belong to no step.
 */
export function stepForFocus(focus: string, ids: SetupIds): SetupStep | undefined {
  const { runtime, panel, roadmapId } = ids;
  if (focus === runtime || focus === `${runtime}-setup`) return 'dependency';
  const sections: readonly (readonly [string, SetupStep])[] = [
    [`${runtime}-native`, 'verification'],
    [`${runtime}-plan-acceptance`, 'plan-acceptance'],
    [`${runtime}-decisions`, 'decisions'],
    [`${runtime}-evidence`, 'evidence'],
    [`map-adoption-${panel}`, 'bindings'],
    [`map-focus-${panel}`, 'bindings'],
    [`map-readiness-${panel}`, 'bindings'],
    [`map-reviewers-${panel}`, 'reviewers'],
    [`map-settings-${panel}`, 'automation'],
    ...(roadmapId
      ? ([
          [`roadmap-setup-${roadmapId}-bindings`, 'bindings'],
          [`future-delegation-${roadmapId}`, 'reviewers'],
          [`scope-recovery-${roadmapId}`, 'reviewers'],
          [`decision-preparation-${roadmapId}`, 'decisions'],
        ] as const)
      : []),
  ];
  return sections.find(([id]) => focus === id)?.[1];
}

/** The step an open attention item's path opens on a roadmap's setup, if it points there. */
export function stepForPath(path: string, roadmapId: string): SetupStep | undefined {
  const match = /\/roadmaps\/([^/#?]+)\/setup#(.+)$/.exec(path);
  if (!match || decodeURIComponent(match[1] ?? '') !== roadmapId) return undefined;
  return stepForFocus(decodeURIComponent(match[2] ?? ''), roadmapSetupIds(roadmapId));
}

/**
 * The page's selected step: the one chosen, else the first `needed`, else the bindings. A
 * reveal of an element in another step, from a link, an inbox item or a notification, shows
 * that step first.
 */
export function useSetupStep(ids: SetupIds | undefined, needed: ReadonlySet<SetupStep>) {
  const [chosen, setChosen] = useState<SetupStep>();
  const key = ids && `${ids.runtime}:${ids.panel}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ids are keyed by their strings.
  useEffect(() => {
    if (!ids) return;
    const show = (event: Event) => {
      const { id, step } = (event as CustomEvent<ShowPart>).detail;
      const next = SETUP_STEPS.find((s) => s.key === step)?.key ?? stepForFocus(id, ids);
      if (next) setChosen(next);
    };
    window.addEventListener(SHOW_PART_EVENT, show);
    return () => window.removeEventListener(SHOW_PART_EVENT, show);
  }, [key]);
  const shown: SetupStep = chosen ?? SETUP_STEPS.find((s) => needed.has(s.key))?.key ?? 'bindings';
  return [shown, setChosen] as const;
}

/** The ordered checklist: the selected step, and the state of each where it is known. */
export function SetupChecklist({
  ids,
  shown,
  onSelect,
  needed = new Set(),
  notNeeded = new Set(),
}: {
  ids: SetupIds;
  shown: SetupStep;
  onSelect: (step: SetupStep) => void;
  needed?: ReadonlySet<SetupStep>;
  notNeeded?: ReadonlySet<SetupStep>;
}) {
  const anchors = stepAnchors(ids);
  return (
    <nav aria-label="Setup checklist" className="setup-checklist">
      <ol>
        {SETUP_STEPS.map((step) => (
          <li key={step.key}>
            <button
              type="button"
              className="link-button"
              aria-current={step.key === shown ? 'step' : undefined}
              onClick={() => {
                onSelect(step.key);
                revealElement(anchors[step.key]);
              }}
            >
              {step.label}
            </button>
            {needed.has(step.key) ? (
              <span className="attention-chip"> · Needs you</span>
            ) : notNeeded.has(step.key) ? (
              <span className="subtle"> · Not needed</span>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}
