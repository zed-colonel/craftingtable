import type {
  DesignRecoveryPreview,
  ExecutionStatusResponse,
  RecoverDesignRequest,
} from '@craftingtable/contracts';
import type { AgentBackendKind, WorkCycle } from '@craftingtable/domain';
import { useState } from 'react';
import { previewDesignRecovery, recoverDesign } from '../../lib/work-cycle-api.js';
import { ModelField } from './ModelField.js';

export function DesignRecoveryPanel({
  cycle,
  backends,
  csrfToken,
  onChanged,
}: {
  cycle: WorkCycle;
  backends: ExecutionStatusResponse['backends'];
  csrfToken: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<DesignRecoveryPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [instructions, setInstructions] = useState('');
  const [mode, setMode] = useState<'investigate' | 'continue'>('investigate');
  const previousProfile = cycle.designRecovery?.profile ?? cycle.profiles.design;
  const [backend, setBackend] = useState<AgentBackendKind>(previousProfile.backend);
  const [model, setModel] = useState(previousProfile.model ?? '');
  const [attachments, setAttachments] = useState<RecoverDesignRequest['attachments']>(
    () => cycle.designRecovery?.attachments.map((file) => ({ ...file })) ?? [],
  );
  const stale = preview !== undefined && preview.expectedVersion !== cycle.version;
  const available = backends.find((entry) => entry.kind === backend)?.available === true;
  const discover = async () => {
    setOpen(true);
    setBusy(true);
    setError(undefined);
    try {
      setPreview(await previewDesignRecovery(cycle));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Evidence discovery failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Resolve design questions" className="stack">
      {!open ? (
        <button type="button" className="primary-button" onClick={() => void discover()}>
          Resolve design questions
        </button>
      ) : (
        <>
          <h3>Resolve design questions</h3>
          <p>
            Uses the existing worktree and full design handoff. Discovery collects saved facts and
            matching documents from exact bound plans; it does not approve evidence or start an
            agent.
          </p>
          {error && (
            <p role="alert" className="error-state">
              {error}
            </p>
          )}
          <button type="button" disabled={busy} onClick={() => void discover()}>
            Refresh available evidence
          </button>
          {busy && <p role="status">Preparing design recovery…</p>}
          {stale && (
            <p role="alert">The cycle changed. Refresh available evidence before continuing.</p>
          )}
          {preview && (
            <>
              <h4>Questions from the latest design</h4>
              <pre className="run-event-body">{preview.questions}</pre>
              <details>
                <summary>Collected facts and source identities</summary>
                <pre className="run-event-body">{preview.facts}</pre>
              </details>
              <details>
                <summary>
                  Shared source documents ({preview.sources.length}) · included automatically
                </summary>
                {preview.sources.map(({ source, content }) => (
                  <details key={source.digest}>
                    <summary style={{ overflowWrap: 'anywhere' }}>{source.name}</summary>
                    <p style={{ overflowWrap: 'anywhere' }}>
                      Plan {source.planVersionId} · SHA-256 {source.digest}
                    </p>
                    <pre className="run-event-body">{content}</pre>
                  </details>
                ))}
              </details>
              <details>
                <summary>Discovery limits and remaining decisions</summary>
                <ul>
                  {preview.notices.map((notice) => (
                    <li key={notice}>{notice}</li>
                  ))}
                </ul>
              </details>
              <form
                className="stack-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (busy || stale || !available) return;
                  setBusy(true);
                  setError(undefined);
                  void recoverDesign(
                    cycle,
                    {
                      expectedVersion: preview.expectedVersion,
                      snapshotDigest: preview.snapshotDigest,
                      mode,
                      instructions,
                      attachments,
                      profile: { backend, ...(model.trim() ? { model: model.trim() } : {}) },
                    },
                    csrfToken,
                  )
                    .then(onChanged)
                    .catch((e: unknown) => {
                      setError(e instanceof Error ? e.message : 'Design recovery failed.');
                    })
                    .finally(() => setBusy(false));
                }}
              >
                <label className="field">
                  Next action
                  <select
                    value={mode}
                    disabled={busy}
                    onChange={(e) => setMode(e.target.value as typeof mode)}
                  >
                    <option value="investigate">Investigate and stop for review</option>
                    <option value="continue">Continue design</option>
                  </select>
                </label>
                <p className="hint">
                  {mode === 'investigate'
                    ? 'Investigation always stops for your review, even if all questions are resolved.'
                    : 'Implementation starts only after the design reports no open questions.'}
                </p>
                <label className="field">
                  Answers and guidance
                  <textarea
                    rows={5}
                    maxLength={16000}
                    value={instructions}
                    disabled={busy}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="Answer ownership or policy questions, identify missing sources, or bound what the agent should investigate."
                  />
                </label>
                <label className="field">
                  Supporting text files (optional; up to 4, 64 KB each)
                  <input
                    type="file"
                    multiple
                    accept=".txt,.md,.json,.yaml,.yml,.toml,.log"
                    disabled={busy}
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      event.target.value = '';
                      if (
                        new Set([...attachments, ...files].map((file) => file.name)).size !==
                          attachments.length + files.length ||
                        files.length + attachments.length > 4 ||
                        files.some((f) => f.size === 0 || f.size > 64000 || f.name.length > 200)
                      ) {
                        setError(
                          'Attach at most four text files with distinct names, each no larger than 64 KB.',
                        );
                        return;
                      }
                      setBusy(true);
                      setError(undefined);
                      void Promise.all(
                        files.map(async (file) => ({
                          name: file.name,
                          content: await file.text(),
                        })),
                      )
                        .then((files) => setAttachments((previous) => [...previous, ...files]))
                        .catch(() => setError('Could not read supporting files.'))
                        .finally(() => setBusy(false));
                    }}
                  />
                </label>
                {attachments.map((file, i) => (
                  <p key={file.name}>
                    {file.name}{' '}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setAttachments(attachments.filter((_, index) => index !== i))}
                    >
                      Remove
                    </button>
                  </p>
                ))}
                <label className="field">
                  Agent
                  <select
                    value={backend}
                    disabled={busy}
                    onChange={(e) => {
                      setBackend(e.target.value as AgentBackendKind);
                      setModel('');
                    }}
                  >
                    {backends.map((entry) => (
                      <option key={entry.kind} value={entry.kind} disabled={!entry.available}>
                        {entry.label}
                        {entry.available ? '' : ' (unavailable)'}
                      </option>
                    ))}
                  </select>
                </label>
                <ModelField
                  key={backend}
                  models={backends.find((entry) => entry.kind === backend)?.models ?? []}
                  value={model}
                  onChange={setModel}
                  disabled={busy}
                />
                <p className="hint">
                  One design attempt, up to {cycle.policy.maxRunMinutes} minutes. Permissions remain{' '}
                  {cycle.profiles.design.permissionMode}. No remediation allowance is consumed.
                  Tags, branch protection and missing test results still need explicit resolution.
                </p>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={busy || stale || !available}
                >
                  {mode === 'investigate'
                    ? 'Start bounded investigation'
                    : 'Continue design with evidence'}
                </button>
              </form>
            </>
          )}
          <button type="button" disabled={busy} onClick={() => setOpen(false)}>
            Close recovery form
          </button>
        </>
      )}
    </section>
  );
}
