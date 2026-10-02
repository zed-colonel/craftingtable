import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { revealElement, SHOW_PART_EVENT, type ShowPart } from '../../lib/reveal-element.js';
import {
  mapSetupIds,
  roadmapSetupIds,
  SetupChecklist,
  type SetupStep,
  SetupStepPart,
  SetupStepProvider,
  stepForFocus,
  stepForPath,
  useSetupStep,
} from './setup-steps.js';

afterEach(cleanup);

function Setup({ initial }: { initial?: SetupStep }) {
  const [step, setStep] = useState<SetupStep | undefined>(initial);
  useEffect(() => {
    const show = (event: Event) => {
      const next = (event as CustomEvent<ShowPart>).detail.steps?.[0] as SetupStep | undefined;
      if (next) setStep(next);
    };
    window.addEventListener(SHOW_PART_EVENT, show);
    return () => window.removeEventListener(SHOW_PART_EVENT, show);
  }, []);
  return (
    <SetupStepProvider value={step}>
      <SetupStepPart step="dependency">
        <p id="pins">Pins</p>
      </SetupStepPart>
      <SetupStepPart step={['reviewers', 'automation']}>
        <p id="settings">Settings</p>
      </SetupStepPart>
    </SetupStepProvider>
  );
}

it('shows only the selected step on setup, and every part elsewhere (R-E2)', () => {
  const view = render(<Setup initial="automation" />);
  expect(document.getElementById('pins')?.closest('[hidden]')).not.toBeNull();
  expect(document.getElementById('settings')?.closest('[hidden]')).toBeNull();
  view.rerender(
    <SetupStepPart step="dependency">
      <p>Outside setup</p>
    </SetupStepPart>,
  );
  expect(screen.getByText('Outside setup').closest('[hidden]')).toBeNull();
});

it('shows the step a revealed element is in, then reveals it', async () => {
  render(<Setup initial="automation" />);
  await act(async () => {
    revealElement('pins');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(document.getElementById('pins')?.closest('[hidden]')).toBeNull();
  expect(document.activeElement?.id).toBe('pins');
});

it('names the step of each setup focus an item or link opens', () => {
  const roadmap = roadmapSetupIds('r1');
  expect(stepForFocus('runtime-evidence-roadmap-r1', roadmap)).toBe('dependency');
  expect(stepForFocus('runtime-evidence-roadmap-r1-native', roadmap)).toBe('verification');
  expect(stepForFocus('decision-preparation-r1', roadmap)).toBe('decisions');
  expect(stepForFocus('map-settings-roadmap-r1', roadmap)).toBe('automation');
  expect(stepForFocus('runtime-evidence-roadmap-r2-native', roadmap)).toBeUndefined();
  // A map's own page, before any roadmap: its panels carry the definition's ids.
  const map = mapSetupIds('def-1');
  expect(stepForFocus('runtime-evidence-def-1-decisions', map)).toBe('decisions');
  expect(stepForFocus('map-reviewers-def-1', map)).toBe('reviewers');
  expect(stepForFocus('map-focus-def-1', map)).toBe('bindings');
  expect(stepForFocus('decision-preparation-def-1', map)).toBeUndefined();
  expect(
    stepForPath('/workspaces/ws/roadmaps/r1/setup#runtime-evidence-roadmap-r1-decisions', 'r1'),
  ).toBe('decisions');
  expect(stepForPath('/workspaces/ws/roadmaps/r1#roadmap-entry-r1-e1', 'r1')).toBeUndefined();
  expect(stepForPath('/workspaces/ws/roadmaps/r2/setup#runtime-evidence-roadmap-r2', 'r1')).toBe(
    undefined,
  );
});

/** A map's setup page: the real checklist and step state, and a part two steps share. */
const MAP = mapSetupIds('d');
const NONE = new Set<never>();
function MapSetup() {
  const [shown, setShown] = useSetupStep(MAP, NONE);
  return (
    <SetupStepProvider value={shown}>
      <SetupChecklist ids={MAP} shown={shown} onSelect={setShown} />
      <button
        type="button"
        onClick={() => {
          setShown('automation');
          revealElement('shared-note');
        }}
      >
        Automation, then its note
      </button>
      <SetupStepPart step="bindings">
        <p id="map-bindings-d">Bindings</p>
      </SetupStepPart>
      <SetupStepPart step={['reviewers', 'automation']}>
        <details id="map-settings-d">
          <summary>Settings</summary>
          <p id="shared-note">A note both steps show</p>
          <SetupStepPart step="reviewers">
            <p>Reviewer part</p>
          </SetupStepPart>
          <SetupStepPart step="automation">
            <p>Automation part</p>
          </SetupStepPart>
        </details>
      </SetupStepPart>
    </SetupStepProvider>
  );
}
const shows = (text: string) => screen.getByText(text).closest('[hidden]') === null;

// Found by R-D4 4c's gate: choosing a step reveals its anchor before the choice renders, while
// the part holding the anchor is still hidden. The part is shared with another step, and the
// reveal used to show the part's first step, replacing the operator's choice.
it("keeps the operator's chosen step when its anchor is in a part another step shares", () => {
  render(<MapSetup />);
  expect(shows('Bindings')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Automation and agents' }));
  expect(shows('Automation part')).toBe(true);
  expect(shows('Reviewer part')).toBe(false);
  expect(shows('Bindings')).toBe(false);
});

it('keeps a step just chosen when a reveal lands in a part it shares', () => {
  render(<MapSetup />);
  fireEvent.click(screen.getByRole('button', { name: 'Automation, then its note' }));
  expect(shows('Automation part')).toBe(true);
  expect(shows('Reviewer part')).toBe(false);
});

it("shows a shared part's first step for a reveal from another step", async () => {
  render(<MapSetup />);
  await act(async () => {
    revealElement('shared-note');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(shows('Reviewer part')).toBe(true);
  expect(shows('Automation part')).toBe(false);
  expect(document.activeElement?.id).toBe('shared-note');
});
