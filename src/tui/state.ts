/**
 * TUI State Store — TUI_DESIGN.md §27
 * Centralized state for the full-screen TUI.
 * Agent Runtime -> Event Stream -> TUI State Store -> Terminal Renderer
 */

import type { TranscriptItem } from './transcript.js';
import type { PlanStep } from '../agent/runtime.js';

export interface TuiState {
  session: {
    id: string;
    cwd: string;
    startedAt: number;
  };
  agent: {
    status: 'idle' | 'running' | 'thinking' | 'verifying' | 'repairing';
    currentTask?: string;
    elapsedMs: number;
  };
  conversation: TranscriptItem[];
  tools: Array<{
    id: string;
    name: string;
    status: 'pending' | 'running' | 'success' | 'failed';
    input: unknown;
    output?: unknown;
    durationMs?: number;
  }>;
  plan: PlanStep[];
  files: {
    changed: Array<{ path: string; status: 'M' | 'A' | 'D'; additions?: number; deletions?: number }>;
  };
  verification: {
    checks: Array<{ name: string; status: 'pending' | 'success' | 'failed'; durationMs?: number; message?: string }>;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
  };
  permissions: {
    pending: Array<{ toolName: string; reason?: string }>;
  };
  input: {
    value: string;
    cursor: number;
    suggestions: string[];
  };
  ui: {
    showThinking: boolean;
    expandedTools: Set<string>;
  };
}

export function createInitialState(cwd: string, model: string): TuiState {
  return {
    session: { id: `sess-${Date.now().toString(36)}`, cwd, startedAt: Date.now() },
    agent: { status: 'idle', elapsedMs: 0 },
    conversation: [],
    tools: [],
    plan: [],
    files: { changed: [] },
    verification: { checks: [] },
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    permissions: { pending: [] },
    input: { value: '', cursor: 0, suggestions: [] },
    ui: { showThinking: false, expandedTools: new Set() },
  };
}
