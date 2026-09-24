/**
 * 3.1 — TerminalRenderer: renders KlyroEvents to terminal (human mode)
 * No direct writes in core — this is the only place that writes to stdout/stderr for human.
 */

import type { KlyroEvent } from '../events/catalog.js';
import { renderMarkdown } from '../cli/markdown.js';
import { sanitizeTerminalText } from '../shared/sanitize.js';

export class TerminalRenderer {
  handle(ev: KlyroEvent): void {
    switch (ev.type) {
      case 'stream.delta':
        process.stdout.write(sanitizeTerminalText(ev.text));
        break;
      case 'tool.call':
        process.stderr.write(`\n[tool] ${sanitizeTerminalText(ev.name)} ${sanitizeTerminalText(JSON.stringify(ev.input).slice(0, 200))}\n`);
        break;
      case 'tool.result':
        process.stderr.write(`  -> ${ev.isError ? 'ERR' : 'ok'} (${ev.latencyMs}ms)\n`);
        break;
      case 'file.changed':
        process.stderr.write(`  ✎ ${sanitizeTerminalText(ev.path)} (${ev.op})\n`);
        break;
      case 'phase.changed':
        process.stderr.write(`\n[phase] ${sanitizeTerminalText(ev.phase)}\n`);
        break;
      case 'verification.started':
        process.stderr.write(`[verify] ${sanitizeTerminalText(ev.command)}\n`);
        break;
      case 'verification.failed':
        process.stderr.write(`[verify] failed: ${sanitizeTerminalText(ev.reason.slice(0, 200))}\n`);
        break;
      case 'error':
        process.stderr.write(`✖ ${sanitizeTerminalText(ev.message)}\n`);
        break;
      default:
        break;
    }
  }

  renderMarkdown(text: string): void {
    const out = renderMarkdown(text, { isTTY: !!process.stdout.isTTY });
    process.stdout.write(sanitizeTerminalText(out));
  }
}

/**
 * Drain-aware stdout write shared by legacy streaming paths (3.1: all
 * human output flows through the terminal renderer module). Sanitizes
 * first, then waits for drain. Returns false if stdout closed (e.g. piped
 * to `head`) or the abort signal fires — callers must stop producing.
 */
export async function writeStdoutDrained(chunk: string, signal?: AbortSignal): Promise<boolean> {
  const clean = sanitizeTerminalText(chunk);
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    if (!process.stdout.write(clean)) {
      let settled = false;
      const cleanup = () => {
        process.stdout.off('drain', onDrain);
        process.stdout.off('error', onError);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onDrain = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(true);
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };
      process.stdout.once('drain', onDrain);
      process.stdout.once('error', onError);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    } else {
      resolve(true);
    }
  });
}
