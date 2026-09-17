import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RuntimeEvidenceView } from '@craftingtable/contracts';
import { NativeVerificationPanel } from './NativeVerificationPanel.js';
import { request } from '../../lib/api-client.js';
vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const view = {
  bindingRevision: 4,
  current: { id: 'runtime' },
  nativeVerification: {
    current: false,
    requirements: [
      {
        resource: 'controlled-native-test-host',
        slices: ['wi/WI-01/implementation'],
        supported: true,
      },
    ],
  },
} as RuntimeEvidenceView;
it('requires reviewed audit and explicit approval, then sends only bounded authorization fields', async () => {
  const saved = vi.fn();
  vi.mocked(request)
    .mockResolvedValueOnce({
      ready: true,
      hostDigest: 'a'.repeat(64),
      auditDigest: 'b'.repeat(64),
      facts: 'Captured limits',
      issues: [],
      kata: { installed: false, kvmAvailable: true, message: 'Not installed' },
    })
    .mockResolvedValueOnce(view);
  render(
    <NativeVerificationPanel
      base="/runtime"
      view={view}
      csrfToken="csrf"
      canMutate
      onSaved={saved}
    />,
  );
  const approve = screen.getByRole('button', {
    name: 'Approve native verification',
  }) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Audit workstation readiness' }));
  await screen.findByText('Native execution smoke test passed. Review before approving.');
  fireEvent.change(screen.getByLabelText('Environment approval rationale'), {
    target: { value: 'Allow repository fixtures' },
  });
  expect(approve.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(approve);
  await waitFor(() => expect(saved).toHaveBeenCalled());
  const [url, , options] = vi.mocked(request).mock.calls[1]!;
  expect(url).toBe('/runtime/authorize-native');
  expect(JSON.parse(options!.body as string)).toEqual({
    bindingRevision: 4,
    runtimeId: 'runtime',
    expectedApprovalId: null,
    approved: true,
    auditDigest: 'b'.repeat(64),
    rationale: 'Allow repository fixtures',
  });
});
it('does not expose execution controls to a read-only viewer', () => {
  render(
    <NativeVerificationPanel
      base="/runtime"
      view={view}
      csrfToken="csrf"
      canMutate={false}
      onSaved={() => {}}
    />,
  );
  expect(
    (screen.getByRole('button', { name: 'Audit workstation readiness' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it('explains an approval tied to an older dependency generation without suggesting another dependency save', () => {
  const stale = {
    ...view,
    current: { ...view.current, id: 'new', generation: 3 },
    history: [{ id: 'old', generation: 2 }],
    nativeVerification: {
      ...view.nativeVerification,
      approval: { id: 'approval', runtimeId: 'old', approved: true },
    },
  } as RuntimeEvidenceView;
  render(
    <NativeVerificationPanel
      base="/runtime"
      view={stale}
      csrfToken="csrf"
      canMutate
      onSaved={() => {}}
    />,
  );
  expect(screen.getByRole('status').textContent).toContain('Approval covers generation 2');
  expect(screen.getByRole('status').textContent).toContain('current saved generation is 3');
  expect(screen.getByRole('status').textContent).toContain('do not need to save');
  expect(request).not.toHaveBeenCalled();
});
