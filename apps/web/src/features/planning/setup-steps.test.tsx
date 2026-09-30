import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { revealElement, SHOW_PART_EVENT, type ShowPart } from '../../lib/reveal-element.js';
import {
  type SetupStep,
  SetupStepPart,
  SetupStepProvider,
  stepForFocus,
  stepForPath,
} from './setup-steps.js';

afterEach(cleanup);

function Setup({ initial }: { initial?: SetupStep }) {
  const [step, setStep] = useState<SetupStep | undefined>(initial);
  useEffect(() => {
    const show = (event: Event) => {
      const next = (event as CustomEvent<ShowPart>).detail.step as SetupStep | undefined;
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
  expect(stepForFocus('runtime-evidence-roadmap-r1', 'r1')).toBe('dependency');
  expect(stepForFocus('runtime-evidence-roadmap-r1-native', 'r1')).toBe('verification');
  expect(stepForFocus('decision-preparation-r1', 'r1')).toBe('decisions');
  expect(stepForFocus('map-settings-roadmap-r1', 'r1')).toBe('automation');
  expect(stepForFocus('runtime-evidence-roadmap-r2-native', 'r1')).toBeUndefined();
  expect(
    stepForPath('/workspaces/ws/roadmaps/r1/setup#runtime-evidence-roadmap-r1-decisions', 'r1'),
  ).toBe('decisions');
  expect(stepForPath('/workspaces/ws/roadmaps/r1#roadmap-entry-r1-e1', 'r1')).toBeUndefined();
  expect(stepForPath('/workspaces/ws/roadmaps/r2/setup#runtime-evidence-roadmap-r2', 'r1')).toBe(
    undefined,
  );
});
