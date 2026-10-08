import type { NormalizedAgentEvent } from './index.js';

/** The most of an agent's stderr one run journals (R-G11, AGT-16). */
export const STDERR_RUN_BUDGET_BYTES = 1024 * 1024;
/** The largest single `stderr` event. */
export const STDERR_EVENT_LIMIT_BYTES = 8 * 1024;
/**
 * How long stderr must be quiet before a partial batch is journaled (operator decision
 * 2026-10-07), so a lone warning shows while the session runs, not only when it ends.
 */
export const STDERR_QUIET_MS = 1000;

const SUPPRESSED_MESSAGE = `stderr suppressed: the agent wrote more than ${STDERR_RUN_BUDGET_BYTES / (1024 * 1024)} MiB to stderr in this run, and the rest is not journaled.`;

/**
 * What of a run's stderr is journaled, shared by every adapter (R-G11, AGT-16): output is
 * batched into events of at most 8 KiB, at most 1 MiB in all, then one notice says the rest
 * was suppressed. A partial batch goes out after a second of quiet. Adapters that scan stderr for diagnostics read the raw chunks themselves;
 * this decides only what is recorded.
 */
export class StderrJournal {
  /** Accepted bytes not yet journaled; never ends inside a character. */
  private pending: Buffer = Buffer.alloc(0);
  /** Bytes accepted for the journal so far, written or pending. */
  private accepted = 0;
  private suppressed = false;

  /** Takes a raw chunk; returns the events to journal now. */
  write(text: string): NormalizedAgentEvent[] {
    if (this.suppressed || text.length === 0) return [];
    const encoded = Buffer.from(text, 'utf8');
    const room = STDERR_RUN_BUDGET_BYTES - this.accepted;
    const kept =
      encoded.length <= room ? encoded : encoded.subarray(0, characterEnd(encoded, room));
    this.accepted += kept.length;
    this.pending = this.pending.length === 0 ? kept : Buffer.concat([this.pending, kept]);
    const events: NormalizedAgentEvent[] = [];
    let offset = 0;
    while (this.pending.length - offset >= STDERR_EVENT_LIMIT_BYTES) {
      const end = offset + characterEnd(this.pending.subarray(offset), STDERR_EVENT_LIMIT_BYTES);
      events.push({
        kind: 'stderr',
        payload: { text: this.pending.toString('utf8', offset, end) },
      });
      offset = end;
    }
    this.pending = this.pending.subarray(offset);
    if (encoded.length > room) {
      this.suppressed = true;
      events.push(...this.flush(), {
        kind: 'notice',
        payload: { category: 'other', message: SUPPRESSED_MESSAGE },
      });
    }
    return events;
  }

  /**
   * What is still pending, once stderr has been quiet (the supervisor's `stderr-quiet`) or the
   * session ends; blank output is not journaled.
   */
  flush(): NormalizedAgentEvent[] {
    const text = this.pending.toString('utf8');
    this.pending = Buffer.alloc(0);
    return text.trim().length > 0 ? [{ kind: 'stderr', payload: { text } }] : [];
  }
}

/** The longest prefix of `bytes`, at most `limit` long, that does not split a character. */
function characterEnd(bytes: Buffer, limit: number): number {
  if (bytes.length <= limit) return bytes.length;
  let end = limit;
  // Back off continuation bytes (10xxxxxx) to the start of the character that would be split.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return end;
}
