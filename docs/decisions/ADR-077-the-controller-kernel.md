# ADR-077: The controller kernel

- **Status:** accepted
- **Date:** 2026-10-19
- **Refines:** ADR-025 (cycles), ADR-066 (drained restarts)

## Context

The cycle controller looked at every active cycle once a second, and again at every workflow
notification, whether anything had changed or not. Each look read the cycle's facts and decided;
most decided nothing. A pass applied its decisions in turn, so one decision that awaited I/O (a
launch's Git preflight, an integration refresh, a review's reassessment) held every other cycle:
a deadline, a turn's end or a stop waited behind it. The 2026-09 system review (R-B5) measured
the daemon idle at about 1.1% CPU, with a stall of about 110 ms every 30 s, and during
transitions with 19 to 23 of every 30 seconds holding a stall of 100 ms or more.

## Decision

The controller is driven by a kernel (`apps/server/src/services/kernel/`) that tells it which
cycles need a look, and when; the controller decides and acts as before (`decide`, R-B4).

- **Marks.** A cycle is marked dirty by a committed write that is not only quiet (an agent's
  activity, attention, deliveries, audit and workspace events are quiet), by a workflow
  notification, by the end of a hold on it (an integration refresh, a transition, a command), by
  its own due time, and by the safety sweep, which marks every cycle every 30 s so a change no
  event reports (Git moved outside the daemon) is still found. Marks are coarse: a write or a
  notification marks every active cycle.
- **Due times.** A pure function (`cycle/core/next-look.ts`) gives a cycle's next look from its
  decision: a step deadline, a retry, an investigation's grace, a restored worktree's minute. One
  timer, never further than the sweep, marks the cycles whose time came. Due times are kept in
  memory; the first round after a start looks at every cycle, and the sweep re-arms the timer from
  the wall clock, so a clock change or a suspend costs at most one sweep.
- **Rounds and the slow lane.** A round decides the marked cycles in priority order and applies
  every decision that awaits nothing at once. A decision that awaits I/O runs as the slow lane's
  one job; while it runs, other cycles' rounds go on, and a cycle that needs the lane waits,
  decided afresh (not queued) when it frees, in the order it came. A cycle a command holds, or the
  lane's own, is left out of rounds until released. A launch's job is withdrawn as a whole when
  its cycle is stopped or paused, or its step's time runs out.
- **Quiescence.** A round's controller pass completes for pushes only once the lane is free and
  nobody waits for it.
- **What tests step.** `WorkCycleService.tick()` stays one serial round over every active cycle,
  its decisions applied in turn, as the replays record them; the kernel's clock is injected.
- **What the operator sees.** The owner-only diagnostics carry a `controller` section (rounds,
  marks by cause, the lane, the timers, the last sweep); a broken invariant met by the controller
  is logged and named in the step history; a job or a command's hold over ten minutes is logged.

## Consequences

- An idle daemon does nothing between sweeps; a slow launch no longer delays another cycle's
  deadline (R-B5's done-when).
- A change that nothing writes, notifies or releases is found by the sweep, up to 30 s later,
  where the one-second loop found it within a second.
- Parts 2 and 3 of R-B5 (bounded backoff, batched agent events, the streams' fallback) build on
  the same kernel.
