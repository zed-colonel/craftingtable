import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as api from '../lib/api-client.js';
import { StepUpDialog } from './StepUpDialog.js';

afterEach(cleanup);

/** The prompt the dialog registered, as `request` calls it (R-G9). */
function registered() {
  const set = vi.spyOn(api, 'setStepUpPrompt');
  render(<StepUpDialog />);
  const prompt = set.mock.calls.at(-1)?.[0];
  if (prompt === undefined) throw new Error('no prompt registered');
  return prompt;
}

it('asks for the password and answers with it', async () => {
  const prompt = registered();
  expect(screen.queryByRole('dialog')).toBeNull();
  let answered!: Promise<string | undefined>;
  act(() => {
    answered = prompt(false);
  });
  expect(screen.getByRole('dialog', { name: 'Confirm your password' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'the password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await expect(answered).resolves.toBe('the password');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('says a password did not match, and answers nothing on Cancel or Escape', async () => {
  const prompt = registered();
  let answered!: Promise<string | undefined>;
  act(() => {
    answered = prompt(true);
  });
  expect(screen.getByRole('alert').textContent).toBe('That password did not match.');
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'typed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await expect(answered).resolves.toBeUndefined();
  act(() => {
    answered = prompt(false);
  });
  // A cancelled password is not kept for the next prompt.
  expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await expect(answered).resolves.toBeUndefined();
});

it('stops answering for the app once it is gone (sign-out)', () => {
  const set = vi.spyOn(api, 'setStepUpPrompt');
  const view = render(<StepUpDialog />);
  view.unmount();
  expect(set).toHaveBeenLastCalledWith(undefined);
});

it('answers every command that asked at once, with one prompt (R-G9 review)', async () => {
  const prompt = registered();
  let first!: Promise<string | undefined>;
  let second!: Promise<string | undefined>;
  act(() => {
    first = prompt(false);
    second = prompt(false);
  });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'the password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await expect(first).resolves.toBe('the password');
  await expect(second).resolves.toBe('the password');
  // A cancel answers them all too.
  act(() => {
    first = prompt(false);
    second = prompt(true);
  });
  // One of them was told its password did not match: the prompt says so.
  expect(screen.getByRole('alert').textContent).toBe('That password did not match.');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await expect(first).resolves.toBeUndefined();
  await expect(second).resolves.toBeUndefined();
});
