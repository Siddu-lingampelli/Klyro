import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { TuiApprovalBridge, ApprovalModal } from './approval.js';

describe('TuiApprovalBridge', () => {
  it('returns a pending prompt until resolve() is called', async () => {
    const bridge = new TuiApprovalBridge();
    expect(bridge.getPending()).toBeNull();
    const choicePromise = bridge.ask({ toolName: 'shell_exec', reason: 'risky', summary: 'rm -rf' });
    const req = bridge.getPending();
    expect(req?.toolName).toBe('shell_exec');
    bridge.resolve('deny');
    await expect(choicePromise).resolves.toBe('deny');
    expect(bridge.getPending()).toBeNull();
  });

  it('resolve() is a no-op when no prompt is pending', () => {
    const bridge = new TuiApprovalBridge();
    expect(bridge.resolve('allow')).toBe(false);
  });

  it('subscribers are notified on pending change', () => {
    const bridge = new TuiApprovalBridge();
    const fn = vi.fn();
    bridge.subscribe(fn);
    const promise = bridge.ask({ toolName: 'x', reason: 'r', summary: 's' });
    expect(fn).toHaveBeenCalledTimes(1);
    bridge.resolve('allow');
    expect(fn).toHaveBeenCalledTimes(2);
    return promise;
  });
});

describe('ApprovalModal', () => {
  function setup() {
    const bridge = new TuiApprovalBridge();
    const { lastFrame, stdin } = render(<ApprovalModal bridge={bridge} />);
    return { bridge, lastFrame, stdin };
  }

  it('renders nothing when no prompt is pending', () => {
    const { lastFrame } = setup();
    expect(lastFrame()).toBe('');
  });

  it('renders the modal when a prompt is pending', async () => {
    const { lastFrame, bridge } = setup();
    const promise = bridge.ask({ toolName: 'shell_exec', reason: 'destructive', summary: 'rm -rf /' });
    await new Promise((r) => setTimeout(r, 5));
    const out = lastFrame();
    expect(out).toContain('approval needed');
    expect(out).toContain('shell_exec');
    expect(out).toContain('destructive');
    expect(out).toContain('rm -rf /');
    expect(out).toContain('allow');
    expect(out).toContain('deny');
    bridge.resolve('deny');
    await promise;
  });

  it('"y" resolves to allow', async () => {
    const { bridge, stdin } = setup();
    const promise = bridge.ask({ toolName: 'x', reason: 'r', summary: 's' });
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('y');
    await new Promise((r) => setTimeout(r, 50));
    await expect(promise).resolves.toBe('allow');
  });

  it('"a" resolves to always', async () => {
    const { bridge, stdin } = setup();
    const promise = bridge.ask({ toolName: 'x', reason: 'r', summary: 's' });
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('a');
    await new Promise((r) => setTimeout(r, 50));
    await expect(promise).resolves.toBe('always');
  });

  it('"n" and "d" resolve to deny', async () => {
    const { bridge: b1, stdin: s1 } = setup();
    const p1 = b1.ask({ toolName: 'x', reason: 'r', summary: 's' });
    await new Promise((r) => setTimeout(r, 50));
    s1.write('n');
    await new Promise((r) => setTimeout(r, 50));
    await expect(p1).resolves.toBe('deny');

    const { bridge: b2, stdin: s2 } = setup();
    const p2 = b2.ask({ toolName: 'x', reason: 'r', summary: 's' });
    await new Promise((r) => setTimeout(r, 50));
    s2.write('d');
    await new Promise((r) => setTimeout(r, 50));
    await expect(p2).resolves.toBe('deny');
  });

  it('Enter resolves to deny', async () => {
    const { bridge, stdin } = setup();
    const promise = bridge.ask({ toolName: 'x', reason: 'r', summary: 's' });
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('\x0d');
    await new Promise((r) => setTimeout(r, 50));
    await expect(promise).resolves.toBe('deny');
  });
});
