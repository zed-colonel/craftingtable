import { afterEach, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { revealElement } from './reveal-element.js';
afterEach(() => {
  document.body.innerHTML = '';
});
it('opens collapsed ancestors and focuses a target that finishes loading after the click', async () => {
  revealElement('loading-setup');
  document.body.innerHTML =
    '<details id="outer"><section><details id="loading-setup"><summary>Setup</summary></details></section></details>';
  await waitFor(() =>
    expect((document.getElementById('loading-setup') as HTMLDetailsElement).open).toBe(true),
  );
  expect((document.getElementById('outer') as HTMLDetailsElement).open).toBe(true);
  expect(document.activeElement?.id).toBe('loading-setup');
});
it('a newer navigation supersedes an older pending target', async () => {
  revealElement('old-target');
  revealElement('new-target');
  document.body.innerHTML =
    '<details id="old-target"><summary>Old</summary></details><details id="new-target"><summary>New</summary></details>';
  await waitFor(() => expect(document.activeElement?.id).toBe('new-target'));
  expect((document.getElementById('old-target') as HTMLDetailsElement).open).toBe(false);
});
