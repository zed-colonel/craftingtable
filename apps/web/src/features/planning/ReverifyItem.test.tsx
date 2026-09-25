import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ReverifyItem } from './ReverifyItem.js';
afterEach(cleanup);

it('offers Re-verify only for an eligible item the viewer may change', () => {
  const onReverify = vi.fn();
  const { rerender } = render(
    <ReverifyItem reverifiable canMutate busy={false} onReverify={onReverify} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Re-verify' }));
  expect(onReverify).toHaveBeenCalledOnce();
  expect(screen.getByText(/Does not resume the roadmap/)).toBeTruthy();
  rerender(<ReverifyItem reverifiable canMutate busy onReverify={onReverify} />);
  expect((screen.getByRole('button', { name: 'Re-verify' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  rerender(<ReverifyItem reverifiable={false} canMutate busy={false} onReverify={onReverify} />);
  expect(screen.queryByRole('button', { name: 'Re-verify' })).toBeNull();
  rerender(<ReverifyItem reverifiable canMutate={false} busy={false} onReverify={onReverify} />);
  expect(screen.queryByRole('button', { name: 'Re-verify' })).toBeNull();
});
