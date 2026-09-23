/**
 * Bounded output collector for child-process stdout/stderr.
 *
 * Mirrors the counter pattern already used by `tools/verify/run-verify.ts:66`.
 * The naive alternative —
 *
 *   child.stdout.on('data', (b) => { if (Buffer.concat(chunks).length < CAP) chunks.push(b); });
 *
 * — re-concatenates everything on *every* chunk, so a chatty verifier (a test
 * suite printing megabytes) burns O(n²) CPU and keeps paying that cost for the
 * rest of the run even after the cap is reached; with no guard at all the heap
 * grows without bound. `push` here is O(1) and stops storing after `capBytes`.
 *
 * Streams are deliberately NOT paused when full: pausing a piped stdout sends
 * backpressure to the child, which can then block on write and never exit —
 * the caller would hang until its own timeout. Draining and discarding is the
 * safe trade: bounded memory, no hang.
 */
export interface CappedOutput {
  /** Store `chunk` (partially, when it overflows the cap). O(1). */
  push(chunk: Buffer): void;
  /** True once a byte was dropped, or a chunk arrived after the cap was hit. */
  readonly truncated: boolean;
  /**
   * Collected bytes decoded as UTF-8. Call once per run: the byte cap also
   * bounds the character count, so no character slicing is needed.
   */
  text(): string;
}

export function cappedOutput(capBytes: number): CappedOutput {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk: Buffer): void {
      if (bytes >= capBytes) {
        truncated = true; // more output exists but is intentionally dropped
        return;
      }
      const room = capBytes - bytes;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        bytes = capBytes;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    },
    get truncated(): boolean {
      return truncated;
    },
    text(): string {
      return Buffer.concat(chunks).toString('utf-8');
    },
  };
}
