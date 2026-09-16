import { useCallback, useEffect, useState } from 'react';
import { About } from '../../components/About.js';
import { Section } from '../../components/Section.js';
import {
  configureRuntimeSchema,
  evidenceSubmissionRequestSchema,
  inspectDependencyResponseSchema,
  runtimeEvidenceViewSchema,
  type ConfigureRuntime,
  type RuntimeEvidenceView,
} from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';
export function RuntimeEvidencePanel({
  workspaceId,
  definitionId,
  bindingRevision,
  csrfToken,
  canMutate,
}: {
  workspaceId: WorkspaceId;
  definitionId: string;
  bindingRevision: number;
  csrfToken: string;
  canMutate: boolean;
}) {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/concurrency-definitions/${encodeURIComponent(definitionId)}/runtime`;
  const [view, setView] = useState<RuntimeEvidenceView>(),
    [config, setConfig] = useState<ConfigureRuntime>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [refs, setRefs] = useState<Record<string, string>>({}),
    [subject, setSubject] = useState(''),
    [evidence, setEvidence] = useState(''),
    [rationale, setRationale] = useState<Record<string, string>>({});
  const adopt = useCallback((v: RuntimeEvidenceView) => {
    setView(v);
    setConfig({
      bindingRevision: v.bindingRevision,
      expectedGeneration: v.current?.generation ?? 0,
      pins:
        v.current?.pins.map((p) => ({
          alias: p.alias,
          ref: p.ref,
          expectedCommitSha: p.commitSha,
          conformanceRevision: p.conformanceRevision,
          packages: p.packages,
        })) ?? [],
      consumers:
        v.current?.consumers ??
        v.repositories
          .filter((r) => r.role === 'planned_application')
          .map((r) => ({ alias: r.alias, upstreams: [] })),
      environments: v.current?.environments ?? [],
    });
  }, []);
  useEffect(() => {
    let alive = true;
    void request(base, runtimeEvidenceViewSchema)
      .then((v) => {
        if (alive) adopt(v);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load runtime evidence.');
      });
    return () => {
      alive = false;
    };
  }, [base, adopt]);
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
  const post = (action: string, body: unknown) =>
    request(`${base}/${action}`, runtimeEvidenceViewSchema, {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify(body),
    });
  if (!view || !config)
    return <p role={error ? 'alert' : undefined}>{error || 'Loading dependency environments…'}</p>;
  const selected = view.subjects.find((s) => `${s.subject.kind}:${s.subject.sourceId}` === subject);
  return (
    <Section
      title="Dependency environments and evidence"
      summary={
        view.current
          ? `Generation ${view.current.generation} · binding ${view.bindingRevision}`
          : 'No dependency environment configured.'
      }
    >
      <About label="About dependency environments">
        <p>
          Pin exact source commits for builds. Review qualification evidence separately. Saving here
          does not start work or adopt map decisions.
        </p>
      </About>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {view.issues.length > 0 && (
        <ul>
          {view.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      <details>
        <summary>Configure pinned dependencies and environments</summary>
        <fieldset disabled={busy || !canMutate || !bindingRevision}>
          <p>
            Inspect a ref in a bound repository to discover its Cargo package mappings. The saved
            pin is an exact commit; later integration changes require a new generation and fresh
            evidence.
          </p>
          {view.repositories.map((repo) => (
            <div key={repo.alias}>
              <label className="field">
                {repo.alias} · branch or commit
                <input
                  value={refs[repo.alias] ?? repo.integrationBranch ?? ''}
                  onChange={(e) => setRefs({ ...refs, [repo.alias]: e.target.value })}
                />
              </label>
              <button
                className="secondary-button"
                type="button"
                disabled={!repo.configured}
                onClick={() =>
                  void act(async () => {
                    const pin = await request(`${base}/inspect`, inspectDependencyResponseSchema, {
                      method: 'POST',
                      headers: { 'x-craftingtable-csrf': csrfToken },
                      body: JSON.stringify({
                        bindingRevision,
                        alias: repo.alias,
                        ref: refs[repo.alias] ?? repo.integrationBranch ?? '',
                      }),
                    });
                    setConfig({
                      ...config,
                      pins: [
                        ...config.pins.filter((p) => p.alias !== repo.alias),
                        {
                          alias: repo.alias,
                          ref: refs[repo.alias] ?? repo.integrationBranch ?? '',
                          expectedCommitSha: pin.commitSha,
                          packages: pin.packages,
                          conformanceRevision:
                            config.pins.find((p) => p.alias === repo.alias)?.conformanceRevision ??
                            '',
                        },
                      ],
                    });
                    setNotice(
                      `Inspected ${repo.alias} at ${pin.commitSha}. Record its conformance revision; all discovered publishable crates will be supplied.`,
                    );
                  })
                }
              >
                Inspect {repo.alias}
              </button>
            </div>
          ))}
          {config.pins.map((pin, index) => (
            <div key={pin.alias}>
              <h4>{pin.alias}</h4>
              <p>
                Ref {pin.ref}
                <br />
                <code className="import-digest">{pin.expectedCommitSha}</code>
              </p>
              <label className="field">
                Conformance revision
                <input
                  value={pin.conformanceRevision}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      pins: config.pins.map((p, i) =>
                        i === index ? { ...p, conformanceRevision: e.target.value } : p,
                      ),
                    })
                  }
                />
              </label>
              <p>Supplied crates: {pin.packages.map((p) => p.name).join(', ')}</p>
              <button
                className="secondary-button"
                type="button"
                onClick={() =>
                  setConfig({
                    ...config,
                    pins: config.pins.filter((p) => p.alias !== pin.alias),
                    consumers: config.consumers.map((c) => ({
                      ...c,
                      upstreams: c.upstreams.filter((u) => u !== pin.alias),
                    })),
                  })
                }
              >
                Remove {pin.alias} pin
              </button>
            </div>
          ))}
          {config.consumers.map((consumer, index) => (
            <fieldset key={consumer.alias}>
              <legend>Dependencies supplied to {consumer.alias}</legend>
              {config.pins
                .filter((p) => p.alias !== consumer.alias)
                .map((pin) => (
                  <label className="checkbox-row" key={pin.alias}>
                    <input
                      type="checkbox"
                      checked={consumer.upstreams.includes(pin.alias)}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          consumers: config.consumers.map((c, i) =>
                            i === index
                              ? {
                                  ...c,
                                  upstreams: e.target.checked
                                    ? [...c.upstreams, pin.alias]
                                    : c.upstreams.filter((u) => u !== pin.alias),
                                }
                              : c,
                          ),
                        })
                      }
                    />
                    {pin.alias}
                  </label>
                ))}
            </fieldset>
          ))}
          <h4>Qualification environments</h4>
          <p>
            Record SHA-256 identities for the host/environment, fixtures and toolchain. External
            native and Kata checks are submitted as reviewed evidence; this does not provision a
            host, grant credentials or launch remote checks.
          </p>
          {config.environments.map((env, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Controlled inputs; editable names are not stable keys.
            <fieldset key={index}>
              <legend>Environment {index + 1}</legend>
              <label className="field">
                Environment name
                <input
                  value={env.id}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      environments: config.environments.map((v, i) =>
                        i === index ? { ...v, id: e.target.value } : v,
                      ),
                    })
                  }
                />
              </label>
              <label className="field">
                Kind
                <select
                  value={env.kind}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      environments: config.environments.map((v, i) =>
                        i === index ? { ...v, kind: e.target.value as typeof env.kind } : v,
                      ),
                    })
                  }
                >
                  <option value="local-development">Local development</option>
                  <option value="external-native">External native qualification</option>
                  <option value="external-kata">Actual Kata qualification</option>
                </select>
              </label>
              {(
                ['identityDigest', 'fixtureDigest', 'toolchainDigest', 'authorization'] as const
              ).map((field) => (
                <label className="field" key={field}>
                  {
                    {
                      identityDigest: 'Environment SHA-256',
                      fixtureDigest: 'Fixture SHA-256',
                      toolchainDigest: 'Toolchain SHA-256',
                      authorization: 'Authorization and scope',
                    }[field]
                  }
                  <input
                    value={env[field]}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        environments: config.environments.map((v, i) =>
                          i === index ? { ...v, [field]: e.target.value } : v,
                        ),
                      })
                    }
                  />
                </label>
              ))}
              <button
                className="secondary-button"
                type="button"
                onClick={() =>
                  setConfig({
                    ...config,
                    environments: config.environments.filter((_, i) => i !== index),
                  })
                }
              >
                Remove environment
              </button>
            </fieldset>
          ))}
          <button
            className="secondary-button"
            type="button"
            onClick={() =>
              setConfig({
                ...config,
                environments: [
                  ...config.environments,
                  {
                    id: '',
                    kind: 'local-development',
                    identityDigest: '',
                    fixtureDigest: '',
                    toolchainDigest: '',
                    authorization: '',
                  },
                ],
              })
            }
          >
            Add environment
          </button>

          <p>
            Saving a generation invalidates earlier evidence for this binding. Historical
            submissions remain available.
          </p>
          <button
            className="secondary-button"
            type="button"
            onClick={() =>
              void act(async () => {
                const input = configureRuntimeSchema.parse(config);
                adopt(await post('configure', input));
                setNotice(
                  'New dependency environment recorded. Prior evidence must be reassessed.',
                );
              })
            }
          >
            Save dependency environment
          </button>
        </fieldset>
      </details>
      <details>
        <summary>Submit qualification or checkpoint evidence</summary>
        <fieldset disabled={busy || !canMutate || !view.current}>
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
                {selected.requirements.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <p>
                Cases:{' '}
                {selected.cases
                  .map((c) => `${c.id}${c.requiresKata ? ' (Kata)' : ''}`)
                  .join(', ') || 'No assigned cases.'}
              </p>
              {selected.issues.map((i) => (
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
          <p>
            Fill in the template or upload an evidence JSON file. Include actual logs and
            independent review text; case names alone do not pass. Identities are external
            attestations that you review. Use sourceRunId only to explicitly reuse a successful
            historical review of the exact same source tree.
          </p>
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
                adopt(
                  await post('submit', evidenceSubmissionRequestSchema.parse(JSON.parse(evidence))),
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
      {view.upstreamHistory.length > 0 && (
        <details>
          <summary>Existing upstream review history</summary>
          <p>
            These are candidate records for explicit reuse. A prior AQ finalization does not
            automatically accept its baseline or publication checkpoint.
          </p>
          <ul>
            {view.upstreamHistory.map((r) => (
              <li key={r.runId}>
                {r.alias} · {r.label}
                <br />
                Run <code>{r.runId}</code>
                <br />
                <code className="import-digest">{r.headSha}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      <details>
        <summary>Pinned build records ({view.builds.length} recent runs)</summary>
        <p>
          Records are frozen when a run ends and survive build-cache cleanup. A successful build is
          development evidence; qualification and publication still require their independent
          review.
        </p>
        {view.builds.map((b) => (
          <p key={b.runId}>
            Run{' '}
            <a
              href={`/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(b.runId)}`}
            >
              {b.runId}
            </a>{' '}
            · {b.successfulBuilds} successful clean builds {b.error && `· ${b.error}`}
            <br />
            <a href={`${base}/runs/${encodeURIComponent(b.runId)}/build-record`}>
              Download frozen build record
            </a>
          </p>
        ))}
      </details>
      <h4>Evidence review</h4>
      {!view.submissions.length && <p>No submissions yet.</p>}
      {view.submissions.map(({ submission: s, decision, issues }) => (
        <details key={s.id}>
          <summary>
            {s.subject.sourceId} · {decision?.outcome ?? 'awaiting review'}
            {issues.length ? ' · blocked or stale' : ''}
          </summary>
          <p>
            Environment {s.environmentId} · tested {s.executedAt} · executor {s.executedBy}
          </p>
          <p>
            Independent reviewers:{' '}
            {s.reviewers.map((r) => `${r.identity} (${r.roles.join(', ')})`).join('; ')}
          </p>
          <p>
            Code:{' '}
            <code className="import-digest">
              {s.subjectCommit ?? 'upstream pins in recorded generation'}
            </code>
          </p>
          {s.testedCode?.map((c) => (
            <p key={c.alias}>
              Tested {c.alias}: <code className="import-digest">{c.commitSha}</code>
            </p>
          ))}
          {issues.length > 0 && (
            <ul>
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
          {s.artifacts.map((a) => (
            <details key={a.name}>
              <summary>{a.name}</summary>
              <code className="import-digest">SHA-256 {a.digest}</code>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{a.content}</pre>
            </details>
          ))}
          {decision ? (
            <p>
              {decision.outcome} · {decision.rationale}
            </p>
          ) : (
            <fieldset disabled={busy || !canMutate}>
              <label className="field">
                Review decision rationale
                <textarea
                  value={rationale[s.id] ?? ''}
                  onChange={(e) => setRationale({ ...rationale, [s.id]: e.target.value })}
                />
              </label>
              {(['accepted', 'rejected'] as const).map((outcome) => (
                <button
                  className="secondary-button"
                  key={outcome}
                  type="button"
                  disabled={
                    !rationale[s.id]?.trim() || (outcome === 'accepted' && issues.length > 0)
                  }
                  onClick={() =>
                    void act(async () => {
                      adopt(
                        await post('decide', {
                          submissionId: s.id,
                          outcome,
                          rationale: rationale[s.id],
                        }),
                      );
                      setNotice(`Evidence ${outcome}.`);
                    })
                  }
                >
                  {outcome === 'accepted' ? 'Accept evidence' : 'Reject evidence'}
                </button>
              ))}
            </fieldset>
          )}
        </details>
      ))}
      {view.history.length > 1 && (
        <details>
          <summary>Environment history ({view.history.length} generations)</summary>
          {view.history.map((g) => (
            <p key={g.id}>
              Generation {g.generation} · {g.createdAt}
              <br />
              <code className="import-digest">{g.digest}</code>
            </p>
          ))}
        </details>
      )}
      <button
        className="secondary-button"
        type="button"
        disabled={busy}
        onClick={() => void act(async () => adopt(await request(base, runtimeEvidenceViewSchema)))}
      >
        Refresh evidence
      </button>
    </Section>
  );
}
