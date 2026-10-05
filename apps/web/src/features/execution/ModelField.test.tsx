import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelField, type ModelOption } from './ModelField.js';

afterEach(cleanup);

/** Claude's aliases, a main and an overflow model, and Codex's models (one hidden). */
const CATALOG: readonly ModelOption[] = [
  { id: 'opus', label: 'Opus (current)', section: 'alias', hidden: false },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', section: 'main', hidden: false },
  { id: 'claude-opus-5', label: 'Opus 5', section: 'overflow', hidden: false },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', section: 'main', hidden: false },
  { id: 'gpt-5.5', label: 'GPT-5.5', section: 'main', hidden: true },
];

function Picker({ initial = '', onChange }: { initial?: string; onChange: (m: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ModelField
      models={CATALOG}
      value={value}
      disabled={false}
      onChange={(model) => {
        setValue(model);
        onChange(model);
      }}
    />
  );
}

const select = () => screen.getByLabelText('Model') as HTMLSelectElement;

it('groups the catalog by section, shows display names and sends ids (R-G15)', () => {
  const onChange = vi.fn();
  render(<Picker onChange={onChange} />);
  const groups = within(select()).getAllByRole('group');
  expect(groups.map((group) => group.getAttribute('label'))).toEqual([
    'Current of each tier',
    'Models',
    'More models',
  ]);
  expect(
    within(groups[1] as HTMLElement)
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['Opus 5.5', 'GPT-6.1-Sol']);
  // A hidden model is not offered, but stays a valid id.
  expect(within(select()).queryByRole('option', { name: 'GPT-5.5' })).toBeNull();
  fireEvent.change(select(), { target: { value: 'gpt-6.1-sol' } });
  expect(onChange).toHaveBeenLastCalledWith('gpt-6.1-sol');
});

it("offers the catalog's id for a typed display name, and sends the id (LIVE-34)", () => {
  const onChange = vi.fn();
  render(<Picker onChange={onChange} />);
  fireEvent.change(select(), { target: { value: '__custom__' } });
  fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'GPT-6.1-Sol' } });
  const warning = screen.getByRole('alert');
  expect(warning.textContent).toContain('gpt-6.1-sol');
  fireEvent.click(within(warning).getByRole('button', { name: 'Use gpt-6.1-sol' }));
  expect(onChange).toHaveBeenLastCalledWith('gpt-6.1-sol');
  // The id is a listed model, so the picker shows it chosen and the warning goes.
  expect(select().value).toBe('gpt-6.1-sol');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('offers the id for another spelling, and keeps a hidden id typed (R-G15)', () => {
  const onChange = vi.fn();
  render(<Picker onChange={onChange} />);
  fireEvent.change(select(), { target: { value: '__custom__' } });
  fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'gpt-5.5' } });
  // A hidden id is in the catalog: nothing to warn about.
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('note')).toBeNull();
  fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'GPT-5.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use gpt-5.5' }));
  expect(onChange).toHaveBeenLastCalledWith('gpt-5.5');
  expect((screen.getByLabelText('Model id') as HTMLInputElement).value).toBe('gpt-5.5');
});

it('warns, without blocking, on an id the catalog does not list (R-G15)', () => {
  const onChange = vi.fn();
  render(<Picker onChange={onChange} />);
  fireEvent.change(select(), { target: { value: '__custom__' } });
  fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'gpt-7-preview' } });
  expect(onChange).toHaveBeenLastCalledWith('gpt-7-preview');
  expect(screen.getByRole('note').textContent).toContain('Not in this agent’s model list');
});

it('shows a chosen hidden model, and an unlisted one under Other… (R-G15)', () => {
  render(<Picker initial="gpt-5.5" onChange={vi.fn()} />);
  expect(select().value).toBe('gpt-5.5');
  cleanup();
  render(<Picker initial="claude-retired-1" onChange={vi.fn()} />);
  expect(select().value).toBe('__custom__');
  expect((screen.getByLabelText('Model id') as HTMLInputElement).value).toBe('claude-retired-1');
  expect(screen.getByRole('note')).toBeTruthy();
});
