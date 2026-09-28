# ADR-054 — Managed native verification and workstation readiness

- Status: accepted
- Date: 2026-09-17

Treat missing execution adapters and environment approvals as actionable configuration,
not occupied capacity. Notify for otherwise eligible verification steps, using durable
reminders; ordinary dependency/capacity waits stay quiet. Supervision links directly to
readiness and approval controls before launch and from blocked entries.

Native execution approval is an immutable, revocable record for an exact map binding,
dependency generation and audited host/toolchain identity. It does not replace a runtime
generation or invalidate unrelated plan evidence. Audits execute fixed version probes and
a bounded user-service smoke test outside database transactions. Only an authenticated
owner/editor can approve the captured audit with a rationale; public input contains no
shell command, executable path or forged audit. Recheck readiness before preparing runs.

The supported controlled-native-test-host resource dispatches a fresh independent review
of integrated code using normal managed worktree provisioning. Its ct-native launcher
uses a transient systemd user service, four CPU quota, 8 GiB memory, 512 tasks, a maximum
30 minute deadline, no-new-privileges, and whole-cgroup cleanup. It supplies fresh HOME
and TMPDIR and a minimal environment. (2026-09-28, R-G4: the daemon, not the agent's launcher,
starts this unit, with a daemon-owned HOME and TMPDIR, and records the receipt in its database.) Existing Cargo toolchain/download storage remains
available. This is cooperative fixture execution under the existing trusted OS-user
model, not isolation from a malicious repository or host user. Approval covers only
non-sensitive repository fixtures; remote credentials and live effects remain excluded.

Each successful native receipt binds the clean reviewed commit, exact dependency and
policy manifest, approval identity, command and retained output digest. Native acceptance
requires this receipt in addition to applicable scoped/current-upstream build gates and
all independent scope evidence. Development/act receipts cannot qualify native execution.
Revocation and host changes prevent new acceptance and reuse of affected scope receipts.
Terminal/restart cleanup stops only the named run unit; unfinished collection fails closed.

Kata infrastructure has a separate root-owned containerd installation, private socket,
pinned runtime release, Workhorse storage and a disposable guest launch/cleanup receipt.
The audit can display that root-owned receipt as historical readiness. It does not grant
agent access to the privileged socket, implement managed Kata dispatch, or satisfy EXO/WI
conformance. Their distinct guest placement/lifecycle obligations still require evidence.

Evidence and native approval applicability across dependency generations are refined by
[ADR-058](ADR-058-reviewed-dependency-refresh.md); original run/receipt provenance remains immutable.
