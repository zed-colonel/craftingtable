import {
  evidenceSubmissionRequestSchema,
  runtimeEvidenceViewSchema,
  type EvidenceSubmissionRequest,
  type RuntimeEvidenceView,
} from '@craftingtable/contracts';
import { useState } from 'react';
import { About } from '../../components/About.js';
import { request } from '../../lib/api-client.js';
import { distinct } from '../../lib/distinct.js';

/**
 * The evidence submission command, `runtime/submit` (R-A6 rest): qualification or checkpoint
 * evidence for the operator's independent review. Private to this module; accepting it is an
 * evidence decision (EvidenceDecision).
 */
function submit(base: string, input: EvidenceSubmissionRequest, csrfToken: string) {
  return request(`${base}/submit`, runtimeEvidenceViewSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify(input),
  });
}

/**
 * Submits qualification or checkpoint evidence for review: a template for the chosen subject, or
 * an uploaded JSON file. A checkpoint's item opens it on that checkpoint (R-A6 rest).
 */
export function SubmitEvidence({
  base,
  view,
  csrfToken,
  disabled,
  id,
  subject: initialSubject = '',
  onSubmitted,
}: {
  /** The API base of the map's dependency environment. */
  base: string;
  view: RuntimeEvidenceView;
  csrfToken: string;
  disabled: boolean;
  id?: string;
  /** The subject chosen at first, as `<kind>:<sourceId>`. */
  subject?: string;
  onSubmitted: (view: RuntimeEvidenceView) => void;
}) {
  const [subject, setSubject] = useState(initialSubject);
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };
  const selected = view.subjects.find((s) => `${s.subject.kind}:${s.subject.sourceId}` === subject);
  return (
    <>
      <details id={id}>
        <summary>Submit qualification or checkpoint evidence</summary>
        <fieldset disabled={disabled || busy || !view.current}>
          <label className="field">
            Evidence subject
            <select
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                setEvidence('');
              }}
            >
              <option value="">Select a slice, parent or checkpoint</option>
              {view.subjects.map((s) => (
                <option
                  key={`${s.subject.kind}:${s.subject.sourceId}`}
                  value={`${s.subject.kind}:${s.subject.sourceId}`}
                >
                  {s.subject.sourceId} · {s.subject.kind}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <>
              <p>
                {selected.title} · profile {selected.profile}
              </p>
              <p>Required independent roles: {selected.reviewerRoles.join(', ')}</p>
              <ul>
                {distinct(selected.requirements).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <p>
                Cases:{' '}
                {selected.cases
                  .map((c) => `${c.id}${c.requiresKata ? ' (Kata)' : ''}`)
                  .join(', ') || 'No assigned cases.'}
              </p>
              {distinct(selected.issues).map((i) => (
                <p key={i}>{i}</p>
              ))}
              <button
                className="secondary-button"
                type="button"
                onClick={() =>
                  setEvidence(
                    JSON.stringify(
                      {
                        runtimeId: view.current!.id,
                        subject: selected.subject,
                        testedCode: selected.testedRepositories.map((alias) => ({
                          alias,
                          commitSha: 'REPLACE_WITH_TESTED_COMMIT',
                        })),
                        environmentId: view.current!.environments[0]?.id ?? '',
                        executedBy: '',
                        executedAt: new Date().toISOString(),
                        reviewers: selected.reviewerRoles.map((role) => ({
                          identity: '',
                          roles: [role],
                          artifact: 'independent-review',
                        })),
                        requirements: selected.requirements.map((requirement) => ({
                          requirement,
                          artifact: 'verification-log',
                        })),
                        cases: selected.cases.map((c) => ({
                          id: c.id,
                          sourceRecordDigest: c.sourceRecordDigest,
                          result: 'passed',
                          artifact: 'verification-log',
                        })),
                        artifacts: [
                          { name: 'verification-log', content: '' },
                          { name: 'independent-review', content: '' },
                        ],
                        ...(selected.cases.some((c) => c.requiresKata)
                          ? {
                              kata: {
                                runtime: 'kata',
                                hostIdentity: '',
                                vmIdentity: '',
                                imageDigest: '',
                                configurationDigest: '',
                                observationArtifact: 'verification-log',
                                noNativeFallback: true,
                              },
                            }
                          : {}),
                      },
                      null,
                      2,
                    ),
                  )
                }
              >
                Prepare evidence template
              </button>
            </>
          )}
          <p>Include actual logs and independent review text; case names alone do not pass.</p>
          <About label="About evidence files">
            <p>
              Fill in the template or upload an evidence JSON file. Identities are external
              attestations that you review. Use sourceRunId only to explicitly reuse a successful
              historical review of the exact same source tree.
            </p>
          </About>
          <label className="field">
            Evidence JSON file
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f)
                  void act(async () => {
                    if (f.size > 5 * 1024 * 1024) throw new Error('Evidence file exceeds 5 MiB.');
                    setEvidence(await f.text());
                  });
              }}
            />
          </label>
          <label className="field">
            Evidence package
            <textarea rows={12} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          </label>
          <button
            className="secondary-button"
            type="button"
            disabled={!evidence}
            onClick={() =>
              void act(async () => {
                onSubmitted(
                  await submit(
                    base,
                    evidenceSubmissionRequestSchema.parse(JSON.parse(evidence)),
                    csrfToken,
                  ),
                );
                setEvidence('');
                setNotice(
                  'Evidence recorded for independent operator review. No checkpoint has been accepted yet.',
                );
              })
            }
          >
            Submit evidence for review
          </button>
        </fieldset>
      </details>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
