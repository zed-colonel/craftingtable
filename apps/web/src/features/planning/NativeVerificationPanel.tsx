import { useState } from 'react';
import {
  nativeAuditSchema,
  runtimeEvidenceViewSchema,
  type RuntimeEvidenceView,
} from '@craftingtable/contracts';
import type { NativeAudit } from '@craftingtable/contracts';
import { request } from '../../lib/api-client.js';
export function NativeVerificationPanel({
  base,
  panelId,
  view,
  csrfToken,
  canMutate,
  onSaved,
}: {
  base: string;
  panelId?: string;
  view: RuntimeEvidenceView;
  csrfToken: string;
  canMutate: boolean;
  onSaved: (v: RuntimeEvidenceView) => void;
}) {
  const [audit, setAudit] = useState<NativeAudit>(),
    [rationale, setRationale] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const native = view.nativeVerification;
  if (!native) return null;
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };
  const save = async (approved: boolean) => {
    const v = await request(`${base}/authorize-native`, runtimeEvidenceViewSchema, {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({
        bindingRevision: view.bindingRevision,
        runtimeId: view.current?.id,
        expectedApprovalId: native.approval?.id ?? null,
        approved,
        auditDigest: audit?.auditDigest ?? native.approval?.auditDigest,
        rationale,
      }),
    });
    onSaved(v);
    setConfirmed(false);
  };
  return (
    <section
      aria-label="Verification environments"
      className="stack-form"
      id={panelId ?? `native-verification-${base.split('/').at(-2)}`}
    >
      <h3>Verification environments</h3>
      <p>
        <strong>
          {native.current
            ? 'Native verification approved'
            : native.approval?.approved
              ? 'Native approval is stale; audit and approve again'
              : 'Native verification needs approval'}
        </strong>
      </p>
      <p>
        Approve non-sensitive repository fixtures on this workstation. CraftingTable provisions
        review worktrees, retains exact test evidence and cleans up bounded test processes. Approval
        does not pass a test, authorize Kata or change dependency pins. Eligible work may dispatch
        when the roadmap is running.
      </p>
      <ul>
        {native.requirements.map((r) => (
          <li key={r.resource}>
            <strong>{r.resource}</strong> · {r.slices.length} verification steps ·{' '}
            {r.supported
              ? 'managed native execution'
              : 'separate qualification; managed dispatch unavailable'}
            <details>
              <summary>Affected slices</summary>
              {r.slices.join(', ')}
            </details>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="secondary-button"
        disabled={!canMutate || busy}
        onClick={() =>
          void act(async () => {
            setAudit(
              await request(`${base}/audit-native`, nativeAuditSchema, {
                method: 'POST',
                headers: { 'x-craftingtable-csrf': csrfToken },
                body: '{}',
              }),
            );
            setConfirmed(false);
          })
        }
      >
        Audit workstation readiness
      </button>
      {audit && (
        <>
          <p role="status">
            {audit.ready
              ? 'Native execution smoke test passed. Review before approving.'
              : 'Native setup is incomplete.'}
          </p>
          <ul>
            {audit.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
          <details>
            <summary>Captured host, toolchains and execution limits</summary>
            <pre>{audit.facts}</pre>
          </details>
          <p>
            Kata: {audit.kata.message} KVM access:{' '}
            {audit.kata.kvmAvailable ? 'available' : 'unavailable'}. Installation alone is not
            application conformance.
          </p>
        </>
      )}
      {native.approval && (
        <details>
          <summary>Saved approval and rationale</summary>
          <p>
            {native.approval.createdAt} · {native.approval.rationale}
          </p>
          <pre>{native.approval.audit}</pre>
        </details>
      )}
      <label className="field">
        Environment approval rationale
        <textarea
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          disabled={!canMutate || busy}
        />
      </label>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          disabled={!audit?.ready || busy || !canMutate}
        />
        I approve non-sensitive repository test fixtures under the displayed limits and existing
        trusted OS-user model. Live service credentials and Kata are excluded.
      </label>
      <div className="action-buttons">
        <button
          type="button"
          className="primary-button"
          disabled={
            !canMutate || busy || !audit?.ready || !confirmed || !rationale.trim() || !view.current
          }
          onClick={() => void act(() => save(true))}
        >
          Approve native verification
        </button>
        {native.approval?.approved && (
          <button
            type="button"
            className="secondary-button"
            disabled={!canMutate || busy || !rationale.trim()}
            onClick={() => void act(() => save(false))}
          >
            Revoke native approval
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
