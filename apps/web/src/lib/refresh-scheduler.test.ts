import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRefreshScheduler, type RefreshTopic } from './refresh-scheduler.js';

describe('refresh scheduler', () => {
  let rounds: (readonly RefreshTopic[])[];
  let finish: (() => void)[];
  let hidden: boolean;
  const scheduler = () =>
    createRefreshScheduler({
      debounceMs: 400,
      maxWaitMs: 2_000,
      hidden: () => hidden,
      run: (topics) => {
        rounds.push([...topics].toSorted());
        return new Promise<void>((resolve) => finish.push(resolve));
      },
    });
  const settleRound = async (): Promise<void> => {
    finish.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    rounds = [];
    finish = [];
    hidden = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for a quiet period and merges the topics of a burst', async () => {
    const s = scheduler();
    s.invalidate(['workspace']);
    await vi.advanceTimersByTimeAsync(300);
    s.invalidate(['roadmaps']);
    await vi.advanceTimersByTimeAsync(399);
    expect(rounds).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(rounds).toEqual([['roadmaps', 'workspace']]);
  });

  it('refreshes by the max-wait while events keep arriving', async () => {
    const s = scheduler();
    for (let elapsed = 0; elapsed < 2_000; elapsed += 250) {
      s.invalidate(['workspace']);
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(rounds).toHaveLength(1);
  });

  it('runs one follow-up round for any number of invalidations during a round', async () => {
    const s = scheduler();
    s.refreshNow(['workspace']);
    expect(rounds).toHaveLength(1);
    for (let index = 0; index < 5; index++) {
      s.invalidate(['workspace']);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    s.refreshNow(['notifications']);
    expect(rounds).toHaveLength(1);
    await settleRound();
    expect(rounds).toEqual([['workspace'], ['notifications', 'workspace']]);
    await settleRound();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rounds).toHaveLength(2);
  });

  it('refreshes immediately after the operator’s own command', () => {
    const s = scheduler();
    s.invalidate(['workspace']);
    s.refreshNow();
    expect(rounds).toEqual([['notifications', 'roadmaps', 'workspace']]);
  });

  it('defers everything while hidden and catches up with one round when shown', async () => {
    const s = scheduler();
    hidden = true;
    s.invalidate(['workspace']);
    await vi.advanceTimersByTimeAsync(3_000);
    s.invalidate(['roadmaps']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rounds).toEqual([]);
    s.visibilityChanged();
    expect(rounds).toEqual([]);
    hidden = false;
    s.visibilityChanged();
    expect(rounds).toEqual([['roadmaps', 'workspace']]);
  });

  it('drops pending work on reset', async () => {
    const s = scheduler();
    s.invalidate(['workspace']);
    s.reset();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rounds).toEqual([]);
  });
});
