import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useStableCallback } from './use-stable-callback.js';

afterEach(cleanup);

it('keeps its identity across renders and always calls the latest function (R-D4 4c)', () => {
  const seen: ((value: number) => number)[] = [];
  function Probe({ fn }: { fn: (value: number) => number }) {
    seen.push(useStableCallback(fn));
    return null;
  }
  const first = vi.fn((value: number) => value + 1);
  const latest = vi.fn((value: number) => value * 10);
  const { rerender } = render(<Probe fn={first} />);
  rerender(<Probe fn={latest} />);
  expect(seen[0]).toBe(seen[1]);
  expect(seen[0]!(2)).toBe(20);
  expect(first).not.toHaveBeenCalled();
});
