import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 5.5d — CI regression gate: `.github/workflows/ci.yml` must keep the
 * smoke-eval step (no `|| echo` fallback). If a future edit deletes the
 * eval gate, this test fails.
 */
describe('ci gate', () => {
  it('ci.yml keeps the smoke-eval gate', () => {
    const ciPath = path.join(process.cwd(), '.github', 'workflows', 'ci.yml');
    const raw = fs.readFileSync(ciPath, 'utf-8');
    expect(raw).toContain('eval --suite smoke');
    expect(raw).toContain('release-check');
  });
});
