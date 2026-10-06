import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { PageBoundary } from './PageBoundary.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// R-D5 review finding 2: a page loaded with its route can fail to load, as an old tab's chunk
// after a deploy does. The page says so and offers a reload, and the rest of the app stays.
it("says a page's code could not be loaded and offers a reload, keeping the app around it", async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const Missing = lazy(() =>
    Promise.reject(new Error('Failed to fetch dynamically imported module')),
  );
  const reload = vi.fn();
  render(
    <main>
      <nav>Rail</nav>
      <PageBoundary reload={reload}>
        <Suspense fallback={<p>Loading page…</p>}>
          <Missing />
        </Suspense>
      </PageBoundary>
    </main>,
  );
  expect((await screen.findByRole('alert')).textContent).toContain('This page could not be loaded');
  expect(screen.getByText('Rail')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(reload).toHaveBeenCalledOnce();
});

it('renders its page when nothing fails', () => {
  render(
    <PageBoundary>
      <p>Page</p>
    </PageBoundary>,
  );
  expect(screen.getByText('Page')).toBeTruthy();
});
