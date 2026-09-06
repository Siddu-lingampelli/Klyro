/**
 * 3.1 — KlyroEvent catalog (Appendix C)
 * Every observable action in the harness is a typed event.
 */

export type KlyroEvent =
  | { type: 'session.start'; ts: number; sessionId: string; task: string; cwd: string; model: string }
  | { type: 'session.end'; ts: number; sessionId: string; status: string; durationMs: number }
  | { type: 'turn.start'; ts: number; sessionId: string; turn: number; model: string }
  | { type: 'turn.end'; ts: number; sessionId: string; turn: number; finishReason?: string }
  | { type: 'stream.delta'; ts: number; sessionId: string; text: string }
  | { type: 'stream.thinking'; ts: number; sessionId: string; text: string }
  | { type: 'tool.call'; ts: number; sessionId: string; callId: string; name: string; input: unknown }
  | { type: 'tool.result'; ts: number; sessionId: string; callId: string; name: string; output: unknown; isError: boolean; latencyMs: number }
  | { type: 'permission.ask'; ts: number; sessionId: string; callId: string; name: string; reason?: string }
  | { type: 'permission.decision'; ts: number; sessionId: string; callId: string; action: 'allow' | 'deny' | 'ask'; reason?: string }
  | { type: 'policy.decision'; ts: number; sessionId: string; callId: string; name: string; action: 'allow' | 'deny' | 'ask'; reason?: string }
  | { type: 'file.changed'; ts: number; sessionId: string; path: string; op: 'created' | 'modified' | 'deleted' }
  | { type: 'phase.changed'; ts: number; sessionId: string; phase: string }
  | { type: 'verification.started'; ts: number; sessionId: string; command: string }
  | { type: 'verification.succeeded'; ts: number; sessionId: string; command: string }
  | { type: 'verification.failed'; ts: number; sessionId: string; command: string; reason: string }
  | { type: 'repair.started'; ts: number; sessionId: string; attempt: number; maxAttempts: number; reason: string }
  | { type: 'checkpoint.saved'; ts: number; sessionId: string }
  | { type: 'usage'; ts: number; sessionId: string; input: number; output: number; cost?: number }
  | { type: 'error'; ts: number; sessionId: string; code: string; message: string; retryable?: boolean }
  | { type: 'abort'; ts: number; sessionId: string; reason: string };

export type KlyroEventType = KlyroEvent['type'];
