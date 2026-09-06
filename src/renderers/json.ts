/**
 * 3.1 — JsonRenderer: renders KlyroEvents as JSON lines (machine mode)
 */

import type { KlyroEvent } from '../events/catalog.js';

export class JsonRenderer {
  private out: NodeJS.WritableStream;

  constructor(out: NodeJS.WritableStream = process.stdout) {
    this.out = out;
  }

  handle(ev: KlyroEvent): void {
    this.out.write(JSON.stringify(ev) + '\n');
  }
}

export class StreamJsonRenderer extends JsonRenderer {
  // Alias for --output-format stream-json
}
