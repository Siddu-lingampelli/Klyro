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
 *      y/a/A/n to the resolver (A = always-persist to settings).
 *
 * Non-TTY mode (no Ink mounted) keeps using StdinApprovalPrompt; this
 * module is only used when the TUI is active.
 */
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalChoice, ApprovalRequest } from '../policy/approval.js';
import type { ApprovalPrompt } from '../policy/approval.js';
import { approvalChoiceForKey, sanitizeForPrompt } from '../policy/approval.js';

interface PendingPrompt {
  req: ApprovalRequest;
  resolve: (choice: ApprovalChoice) => void;
}

class TuiApprovalBridge implements ApprovalPrompt {
  private pending: PendingPrompt | null = null;
  // Fan-out set: BOTH the App (awaitingApproval gate) and the ApprovalModal
  // subscribe. The old single slot meant the last subscriber silently
  // unsubscribed the other — the modal never rendered and approvals hung.
  private listeners = new Set<(p: PendingPrompt | null) => void>();

  ask(req: ApprovalRequest): Promise<ApprovalChoice> {
    return new Promise<ApprovalChoice>((resolve) => {
      this.pending = { req, resolve };
      for (const l of this.listeners) {
        try {
          l(this.pending);
        } catch { /* ignore listener errors */ }
      }
    });
  }

  /** Called by the App's useInput to consume the pending prompt. */
  resolve(choice: ApprovalChoice): boolean {
    if (!this.pending) return false;
    const p = this.pending;
    this.pending = null;
    for (const l of this.listeners) {
      try {
        l(null);
      } catch { /* ignore listener errors */ }
    }
    p.resolve(choice);
    return true;
  }

  getPending(): ApprovalRequest | null {
    return this.pending?.req ?? null;
  }

  /** Used by useSyncExternalStore-ish wiring in <ApprovalModal/>. */
  subscribe(listener: (p: PendingPrompt | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export { TuiApprovalBridge };

/** Mounted inside the Ink App. Renders a modal when a prompt is pending. */
export function ApprovalModal({ bridge }: { bridge: TuiApprovalBridge }): React.JSX.Element | null {
  const [pending, setPending] = useState<ApprovalRequest | null>(bridge.getPending());

  useEffect(() => {
    return bridge.subscribe((p) => setPending(p?.req ?? null));
  }, [bridge]);

  const [explain, setExplain] = useState(false);
  const [full, setFull] = useState(false);
  useInput((inputStr, key) => {
    if (!pending) return;
    if (key.return) {
      bridge.resolve('deny');
      return;
    }
    // Case-sensitive mapping lives in approvalChoiceForKey: 'A' persists,
    // 'a' is session-only (the old inline toLowerCase-first code collapsed
    // them, silently downgrading persistence).
    const action = approvalChoiceForKey(inputStr);
    if (action === 'expand') {
      setFull((v) => !v);
      return;
    }
    if (action === 'explain') {
      setExplain((v) => !v);
      return;
    }
    if (action === 'allow' || action === 'always' || action === 'always-persist' || action === 'deny') {
      bridge.resolve(action);
      return;
    }
  });

  if (!pending) return null;
  // Sanitized display (ANSI/control-strip + 500-char cap inside
  // sanitizeForPrompt), then the 300-char TUI truncation on top. [f] toggles
  // the full sanitized text.
  const trunc = (s: string, n = 300): string => {
    const clean = sanitizeForPrompt(s);
    return !full && clean.length > n ? clean.slice(0, n) + '…' : clean;
  };
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      marginY={1}
    >
      <Text color="yellow" bold>⚠ approval needed — {pending.toolName}</Text>
      <Text color="gray">  reason: &quot;{trunc(pending.reason)}&quot;</Text>
      {pending.summary ? <Text>  &quot;{trunc(pending.summary)}&quot;</Text> : null}
      {explain ? <Text color="cyan">  Explain: This tool will {pending.toolName} with the shown args. [y] once, [a] session, [A] always→settings, [n] deny, [e] edit, [f] full text, [?] toggle help.</Text> : null}
      <Box marginTop={1}>
        <Text color="green">[y] once</Text>
        <Text color="gray">  </Text>
        <Text color="green">[a] session</Text>
        <Text color="gray">  </Text>
        <Text color="green">[A] always</Text>
        <Text color="gray">  </Text>
        <Text color="red">[n] deny</Text>
        <Text color="gray">  </Text>
        <Text color="yellow">[e] edit</Text>
        <Text color="gray">  </Text>
        <Text color="cyan">[f] full</Text>
        <Text color="gray">  </Text>
        <Text color="cyan">[?] explain</Text>
        <Text color="gray">  (Enter = deny)</Text>
      </Box>
    </Box>
  );
}
