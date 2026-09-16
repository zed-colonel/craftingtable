import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Reasons } from './Reasons.js';
import { Section } from './Section.js';
import { StatusStrip } from './StatusStrip.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Reasons', () => {
  it('groups typed reasons by who resolves them and drops duplicates', () => {
    render(
      <Reasons
        reasons={[
          { kind: 'dependency', text: 'Merge AQ-01 first.' },
          { kind: 'authorization', text: 'The bound repository is unavailable.' },
          { kind: 'resource', text: 'Waiting for a development slot.' },
          { kind: 'authorization', text: 'The bound repository is unavailable.' },
        ]}
      />,
    );
    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual(['Needs you', 'Waiting on automation', 'Waiting on other work']);
    expect(screen.getAllByText('The bound repository is unavailable.')).toHaveLength(1);
    expect(screen.getByText('Merge AQ-01 first.')).toBeDefined();
  });

  it('states explicitly when nothing is waiting', () => {
    render(<Reasons reasons={[]} satisfied="Nothing is waiting." />);
    expect(screen.getByText('Nothing is waiting.')).toBeDefined();
  });
});

describe('Section', () => {
  it('keeps its landmark name whether or not the body is collapsed', () => {
    render(
      <Section title="Branches" collapsible defaultOpen={false}>
        <p>revision</p>
      </Section>,
    );
    const region = screen.getByRole('region', { name: 'Branches' });
    expect(within(region).getByRole('heading', { level: 2 }).textContent).toBe('Branches');
    expect(region.querySelector('details')?.open).toBe(false);
  });

  it('shows a count and a summary in its head', () => {
    render(
      <Section title="Worktrees" count={2} summary="One is reviewed and mergeable.">
        <p>body</p>
      </Section>,
    );
    const region = screen.getByRole('region', { name: 'Worktrees' });
    expect(within(region).getByText('2')).toBeDefined();
    expect(within(region).getByText('One is reviewed and mergeable.')).toBeDefined();
  });
});

describe('StatusStrip', () => {
  it('renders labelled facts and omits empty ones', () => {
    render(
      <StatusStrip
        label="Run facts"
        facts={[
          { label: 'Model', value: 'fake-model', mono: true },
          { label: 'Verdict', value: undefined },
          { label: 'Turns', value: 3 },
        ]}
      />,
    );
    const strip = screen.getByLabelText('Run facts');
    expect(
      within(strip)
        .getAllByRole('term')
        .map((t) => t.textContent),
    ).toEqual(['Model', 'Turns']);
  });
});
