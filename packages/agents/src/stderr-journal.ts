import type { NormalizedAgentEvent } from './index.js';

/** The most of an agent's stderr one run journals (R-G11, AGT-16). */
export const STDERR_RUN_BUDGET_BYTES = 1024 * 1024;
/** The largest single `stderr` event. */
export const STDERR_EVENT_LIMIT_BYTES = 8 * 1024;

const SUPPRESSED_MESSAGE = `stderr suppressed: the agent wrote more than ${STDERR_RUN_BUDGET_BYTES / (1024 * 1024)} MiB to stderr in this run, and the rest is not journaled.`;

/**
 * What of a run's stderr is journaled, shared by every adapter (R-G11, AGT-16): output is
 * batched into events of at most 8 KiB, at most 1 MiB in all, then one notice says the rest
 * was suppressed. Adapters that scan stderr for diagnostics read the raw chunks themselves;
 * this decides only what is recorded.
 */
export class StderrJournal {
  private pending = '';
  private pendingBytes = 0;
  /** Bytes accepted for the journal so far, written or pending. */
  private accepted = 0;
  private suppressed = false;

  /** Takes a raw chunk; returns the events to journal now. */
  write(text: string): NormalizedAgentEvent[] {
    if (this.suppressed || text.length === 0) return [];
    const room = STDERR_RUN_BUDGET_BYTES - this.accepted;
    const bytes = Buffer.byteLength(text, 'utf8');
    const kept = bytes <= room ? text : utf8Prefix(text, room);
    const keptBytes = bytes <= room ? bytes : Buffer.byteLength(kept, 'utf8');
    this.pending += kept;
    this.pendingBytes += keptBytes;
    this.accepted += keptBytes;
    const events: NormalizedAgentEvent[] = [];
    while (this.pendingBytes >= STDERR_EVENT_LIMIT_BYTES) {
      const slice = utf8Prefix(this.pending, STDERR_EVENT_LIMIT_BYTES);
      this.pending = this.pending.slice(slice.length);
      this.pendingBytes -= Buffer.byteLength(slice, 'utf8');
      events.push({ kind: 'stderr', payload: { text: slice } });
    }
    if (bytes > room) {
      this.suppressed = true;
      events.push(...this.flush(), {
        kind: 'notice',
        payload: { category: 'other', message: SUPPRESSED_MESSAGE },
      });
    }
    return events;
  }

  /** What is still pending, at the session's end; blank output is not journaled. */
  flush(): NormalizedAgentEvent[] {
    const text = this.pending;
    this.pending = '';
    this.pendingBytes = 0;
    return text.trim().length > 0 ? [{ kind: 'stderr', payload: { text } }] : [];
  }
}

/** The longest prefix of `text` within `bytes` UTF-8 bytes that does not split a character. */
function utf8Prefix(text: string, bytes: number): string {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= bytes) return text;
  let end = bytes;
  // Back off continuation bytes (10xxxxxx) to the start of the character that would be split.
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString('utf8');
}
