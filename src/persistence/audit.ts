/**
 * Audit log — append-only JSONL of runtime events. Same shape as the
 * future durable-task scheduler will read, so the data layout is
 * forward-compatible.
 */

import { SessionStore } from './store.js';

export type AuditEvent =
  | { kind: 'session_created'; sessionId: string; task: string; cwd: string; ts: number }
  | { kind: 'session_resumed'; sessionId: string; ts: number }
  | { kind: 'session_completed'; sessionId: string; status: string; ts: number }
  | { kind: 'step_started'; sessionId: string; step: number; ts: number }
  | { kind: 'step_completed'; sessionId: string; step: number; ts: number }
  | { kind: 'tool_call_started'; sessionId: string; callId: string; name: string; ts: number }
  | { kind: 'tool_call_completed'; sessionId: string; callId: string; isError: boolean; latencyMs: number; ts: number }
  | { kind: 'policy_decision'; sessionId: string; callId: string; action: string; ts: number }
  | { kind: 'verification_attempted'; sessionId: string; command: string; ts: number }
  | { kind: 'verification_succeeded'; sessionId: string; ts: number }
  | { kind: 'verification_failed'; sessionId: string; exitCode: number; type: string; ts: number }
  | { kind: 'repair_attempted'; sessionId: string; attempt: number; ts: number };

export class AuditLog {
  constructor(private readonly filePath: string) {}

  async write(event: AuditEvent): Promise<void> {
    await SessionStore.appendJsonl(this.filePath, event);
  }
}
