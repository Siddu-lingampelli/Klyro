/**
 * TUI approval prompt — a TUI-native replacement for StdinApprovalPrompt.
 *
 * Why not just keep StdinApprovalPrompt and use readline?
 *   Ink owns stdin via useInput. If readline is also attached to stdin,
 *   their events race and the user sees garbled or missing input.
 *
 * The runtime calls `ask(req)` from inside the agent loop and awaits the
 * choice. This module sits between them:
 *
 *   1. The Ink App registers a resolver via setResolver() in useEffect.
 *   2. When the runtime calls ask(), we stash the request and return
 *      a Promise.
 *   3. The App polls getPending() on every render to show a modal.
 *   4. The App's useInput handler sees a pending prompt and routes
 *      y/n/a to the resolver.
 *
 * Non-TTY mode (no Ink mounted) keeps using StdinApprovalPrompt; this
 * module is only used when the TUI is active.
 */
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalChoice, ApprovalRequest } from '../policy/approval.js';
import type { ApprovalPrompt } from '../policy/approval.js';

interface PendingPrompt {
  req: ApprovalRequest;
  resolve: (choice: ApprovalChoice) => void;
}

class TuiApprovalBridge implements ApprovalPrompt {
  private pending: PendingPrompt | null = null;
  private listener: ((p: PendingPrompt | null) => void) | null = null;

  ask(req: ApprovalRequest): Promise<ApprovalChoice> {
    return new Promise<ApprovalChoice>((resolve) => {
      this.pending = { req, resolve };
      this.listener?.(this.pending);
    });
  }

  /** Called by the App's useInput to consume the pending prompt. */
  resolve(choice: ApprovalChoice): boolean {
    if (!this.pending) return false;
    const p = this.pending;
    this.pending = null;
    this.listener?.(null);
    p.resolve(choice);
    return true;
  }

  getPending(): ApprovalRequest | null {
    return this.pending?.req ?? null;
  }

  /** Used by useSyncExternalStore-ish wiring in <ApprovalModal/>. */
  subscribe(listener: (p: PendingPrompt | null) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }
}

export { TuiApprovalBridge };

/** Mounted inside the Ink App. Renders a modal when a prompt is pending. */
export function ApprovalModal({ bridge }: { bridge: TuiApprovalBridge }): React.JSX.Element | null {
  const [pending, setPending] = useState<ApprovalRequest | null>(bridge.getPending());

  useEffect(() => {
    return bridge.subscribe((p) => setPending(p?.req ?? null));
  }, [bridge]);

  useInput((inputStr, key) => {
    if (!pending) return;
    const c = inputStr.toLowerCase();
    if (c === 'y' || c === 'a' || c === 'd' || c === 'n') {
      const choice: ApprovalChoice = (c === 'y' || c === 'a') ? (c === 'a' ? 'always' : 'allow') : 'deny';
      bridge.resolve(choice);
      return;
    }
    if (key.return) {
      bridge.resolve('deny');
      return;
    }
  });

  if (!pending) return null;
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      marginY={1}
    >
      <Text color="yellow" bold>⚠ approval needed — {pending.toolName}</Text>
      <Text color="gray">  reason: {pending.reason}</Text>
      {pending.summary ? <Text>  {pending.summary}</Text> : null}
      <Box marginTop={1}>
        <Text color="green">[y] allow</Text>
        <Text color="gray">  </Text>
        <Text color="green">[a] always allow</Text>
        <Text color="gray">  </Text>
        <Text color="red">[d] deny</Text>
        <Text color="gray">  (Enter = deny)</Text>
      </Box>
    </Box>
  );
}
