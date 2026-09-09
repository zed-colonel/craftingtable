import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api-client.js';
import { LoginPage } from './LoginPage.js';

afterEach(cleanup);
it.each([
  [
    new ApiError(401, 'invalid-credentials', 'Invalid username or password'),
    'Sign-in failed. Check your username and password.',
  ],
  [
    new ApiError(
      403,
      'forbidden',
      'Sign-in is only allowed from https://workstation.example.test. Open that address and try again.',
    ),
    'Sign-in is only allowed from https://workstation.example.test. Open that address and try again.',
  ],
  [
    new ApiError(500, 'internal-error', 'Internal error'),
    'The server could not complete sign-in. Try again shortly.',
  ],
  [
    new TypeError('Failed to fetch'),
    'Sign-in could not be completed. Check your connection and reload the page.',
  ],
])(
  'distinguishes credentials, address, server and network failures: %s',
  async (error, expected) => {
    render(<LoginPage onLogin={vi.fn().mockRejectedValue(error)} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'keith' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'example test passphrase' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe(expected);
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  },
);
