/**
 * 3.1 — TerminalRenderer: renders KlyroEvents to terminal (human mode)
 * No direct writes in core — this is the only place that writes to stdout/stderr for human.
 */

import type { KlyroEvent } from '../events/catalog.js';
import { renderMarkdown } from '../cli/markdown.js';

export class TerminalRenderer {
  handle(ev: KlyroEvent): void {
    switch (ev.type) {
      case 'stream.delta':
        process.stdout.write(ev.text);
        break;
      case 'tool.call':
        process.stderr.write(`\n[tool] ${ev.name} ${JSON.stringify(ev.input).slice(0, 200)}\n`);
        break;
      case 'tool.result':
        process.stderr.write(`  -> ${ev.isError ? 'ERR' : 'ok'} (${ev.latencyMs}ms)\n`);
        break;
      case 'file.changed':
        process.stderr.write(`  ✎ ${ev.path} (${ev.op})\n`);
        break;
      case 'phase.changed':
        process.stderr.write(`\n[phase] ${ev.phase}\n`);
        break;
      case 'verification.started':
        process.stderr.write(`[verify] ${ev.command}\n`);
        break;
      case 'verification.failed':
        process.stderr.write(`[verify] failed: ${ev.reason.slice(0, 200)}\n`);
        break;
      case 'error':
        process.stderr.write(`✖ ${ev.message}\n`);
        break;
      default:
        break;
    }
  }

  renderMarkdown(text: string): void {
    const out = renderMarkdown(text, { isTTY: !!process.stdout.isTTY });
    process.stdout.write(out);
  }
}
