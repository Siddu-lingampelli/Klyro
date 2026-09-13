import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initProject } from './init.js';

describe('initProject', () => {
  it('creates KLYRO.md + .mcp.json once, never overwrites', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-init-'));
    try {
      const first = await initProject(dir);
      expect(first.created).toContain('KLYRO.md');
      expect(first.created).toContain('.mcp.json');
      expect(fs.existsSync(path.join(dir, 'KLYRO.md'))).toBe(true);
      const second = await initProject(dir);
      expect(second.created).toEqual([]);
      expect(second.skipped.length).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
