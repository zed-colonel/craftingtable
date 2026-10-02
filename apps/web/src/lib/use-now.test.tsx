import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNow } from './use-now.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Clock({ onRender }: { onRender: () => void }) {
  onRender();
  return <p>{new Date(useNow()).toISOString()}</p>;
}

// R-D4 increment 4b: elapsed times tick where they show, not by re-rendering the whole app.
it('ticks every ten seconds while the page is visible, and not while it is hidden', () => {
  const renders = vi.fn();
  render(<Clock onRender={renders} />);
  expect(screen.getByText('2026-10-02T00:00:00.000Z')).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(9_999);
  });
  expect(renders).toHaveBeenCalledTimes(1);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(screen.getByText('2026-10-02T00:00:10.000Z')).toBeTruthy();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  try {
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText('2026-10-02T00:00:10.000Z')).toBeTruthy();
  } finally {
    visibility.mockRestore();
  }
});

it('stops ticking once unmounted', () => {
  const { unmount } = render(<Clock onRender={() => undefined} />);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
