# ADR-062: Bounded recovery from model-service failures

Status: accepted
Date: 2026-09-22

A temporary model-service failure is neither a source finding nor an invalid-report remediation.
Adapters normalize trusted structured failure discriminants into a vendor-neutral optional turn
field. Prose, raw stderr and old raw vendor records never authorize automatic retries. Codex capacity,
server and recognized transport failures and Claude structured server failures are eligible only
with terminal failure and settled tools. Authentication, quotas/rate limits, unknown errors,
interactive requests, ambiguous tools, background timeouts and genuine questions require attention.
Claude's discriminants follow the [official SDK message types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py);
Codex's follow the installed app-server's generated CodexErrorInfo schema.

The controller reserves at most three same-step retries after 1, 5 and 15 minutes. Durable cycle
state records the failed run, backend/model, attempts and due time. Retries share the original step
deadline and retain partial work, guidance and handoff lineage, without debiting remediation rounds.
A normal next step clears the service allowance. Retry now advances the due time only; it cannot
increase allowance, extend the deadline or bypass gates. Explicit ordinary resume after exhaustion
opens a new operator-authorized step window. Pause and stop retain existing workflow meanings.

A retry cannot launch before terminal process-group cleanup and run-storage cleanup, while its
roadmap is paused, after authority/admission changes, or across conflicting worktree lineage.
Launch revalidates phase, dependency and evidence gates and reserves resources normally. Waiting
backoff holds no process resource reservation. Daemon restart holds running cycles for explicit
resumption and preserves the retry budget. Notifications use the existing cycle attention path:
backoff is progress, exhaustion or an unsafe failure needs attention.

Fresh sessions are deliberate. Thread resume can carry stale cwd, sandbox/additional directories,
dependency launchers and run-specific receipt identity. Recompose current context and export the
full prior conversation instead. Pinned review continuations permit existing verification artifacts
only under the established unchanged HEAD/target/index checks; they cannot adopt partial reports.
The new review must finish successfully, produce a valid complete report and satisfy normal gates.
No retry grants new model, merge or protected-branch promotion authority.
