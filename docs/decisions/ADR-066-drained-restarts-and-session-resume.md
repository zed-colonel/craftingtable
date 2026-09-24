# ADR-066: Drained restarts and session resume

Status: accepted
Date: 2026-09-23

## Context

Agents are children of the daemon connected by stdio pipes, so a restarted daemon cannot
re-attach to a live run. Until now every restart interrupted live runs and set every running
cycle and roadmap to needs-attention (ADR-025, ADR-029), so each deploy of CraftingTable cost a
manual pause, deploy, resume and inspect round (review findings HIST-06, CTRL-20). The operator
decided on 2026-09-23 to combine a bounded drain with automatic resume of interrupted steps
(register item R-B9). Agents that outlive the daemon are a later item (R-G12).

## Decision

A stop drains. The daemon stops admitting agent runs and roadmap work, waits up to a bound
(`CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS`, default 180) or, for `pnpm deploy:daemon --when-idle`,
until no turn is live, while the controller keeps supervising. It then stops the controller
loops, interrupts what is still live with the typed exit reason `daemon-drain`, and writes a
clean-stop row in the database. `pnpm deploy:daemon` requests the drain through a file in the
data directory before switching releases, so the drain does not depend on how systemd delivers
signals; `SIGTERM` runs the same drain as a best effort.

The next start consumes the clean-stop row. It counts only when no run was still live in the
database. After a clean stop, running cycles and roadmaps stay running. A step whose run ended
`daemon-drain` and reported a vendor session id is relaunched as a new run whose parent is the
interrupted run, resuming that session (`claude --resume`, Codex `thread/resume`) in the same
worktree with the interrupted run's backend, model and permissions, the cycle's guidance and
the original step deadline. A resumed review continues on its pinned review baseline. Its
first message states that the daemon restarted, that the last tool call may be incomplete, and
where the refreshed brief and tool paths are.

A crash, a drain that did not complete, a run without a session id, and a resume that fails
keep the explicit operator resume. Migrations on start first copy a populated database to
`state/pre-migration/`.

## Consequences

- A deploy costs at most the drain bound plus the redone tool call; roadmaps continue without
  the operator and without a page.
- ADR-062 prefers fresh sessions for provider retries because a resumed thread can carry stale
  run-specific paths. That still holds for retries. For a drained restart the conversation is
  the work in progress, so it is resumed; the new process gets the new run's environment,
  launchers and directories, the old run directory stays readable, and the resume message
  points at the new paths. A launcher or receipt from the old run that the agent reuses by
  absolute path is not evidence for the new run, so gates stay intact.
- The clean-stop row is the only new persisted state; cycles gain no field. The resume is
  derived from the interrupted run's typed exit reason and the cycle's parent run.
- A plain `systemctl stop` drains only with `KillMode=mixed` and a stop timeout above the bound.

## Amendment (2026-09-24)

Two changes followed the phase 1 review.

- **A drain with no restart ends in a restart.** A drain a deploy requested stops the loops and refuses launches. If no restart follows within two minutes, the daemon exits with status 75 so the service manager restarts it and the clean stop resumes automation. That happens when the deploy is interrupted after the drain: a late Ctrl-C, a closed terminal, or a failure before `systemctl restart`. The deploy script also withdraws its request on SIGHUP and SIGTERM.
- **Only a daemon that is itself stopping treats killed agents as a restart.** An agent killed by a signal counts as a drain interruption only while the daemon is stopping on a signal, because then the service manager's signal can reach the agents' process groups too. During a deploy's drain nothing else stops, so an agent killed by a signal, such as the OOM killer, is a failure and keeps the explicit resume.

## Alternatives considered

- Resume every interrupted step, including after crashes: a crash can leave Git operations or
  reservations half-applied, so the operator still inspects those.
- Fresh sessions for interrupted steps: loses the conversation and repeats completed work.
- Signals only (`SIGUSR2` to begin a drain): an older daemon's default action for the signal is
  to exit, and the unit's process-group kill reaches the agents directly.
