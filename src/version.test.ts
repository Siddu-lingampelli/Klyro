import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readVersion } from './version.js';

describe('readVersion (single source of truth)', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
    expect(readVersion()).toBe(pkg.version);
  });

  it('never returns an empty or placeholder version', () => {
    const v = readVersion();
    expect(v.length).toBeGreaterThan(0);
    expect(v).not.toBe('0.1.27');
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});
