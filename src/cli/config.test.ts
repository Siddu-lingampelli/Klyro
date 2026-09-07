import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _helpers, persistAllowRule, loadPermissionRules } from './config.js';

describe('config path hardening', () => {
  it('setByPath refuses prototype pollution', () => {
    const obj: Record<string, unknown> = {};
    expect(() => _helpers.setByPath(obj, '__proto__.polluted', true)).toThrow(/prototype-polluting/);
    expect(() => _helpers.setByPath(obj, 'a.constructor', 1)).toThrow(/prototype-polluting/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(obj).toEqual({});
  });

  it('deleteByPath refuses prototype keys', () => {
    expect(_helpers.deleteByPath({ a: 1 }, '__proto__')).toBe(false);
  });

  it('normal dotted paths still work', () => {
    const obj: Record<string, unknown> = {};
    _helpers.setByPath(obj, 'model.default', 'gpt-4o-mini');
    expect(_helpers.getByPath(obj, 'model.default')).toBe('gpt-4o-mini');
  });
});

describe('persisted allow rules', () => {
  let dir: string;
  let oldConfig: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-cfg-'));
    oldConfig = process.env.KLYRO_CONFIG;
    process.env.KLYRO_CONFIG = path.join(dir, 'settings.json');
  });

  afterEach(() => {
    if (oldConfig === undefined) delete process.env.KLYRO_CONFIG;
    else process.env.KLYRO_CONFIG = oldConfig;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persistAllowRule round-trips through loadPermissionRules', async () => {
    const r1 = await persistAllowRule('shell_exec(npm *)');
    expect(r1.added).toBe(true);
    const r2 = await persistAllowRule('shell_exec(npm *)');
    expect(r2.added).toBe(false);
    const rules = await loadPermissionRules(dir);
    expect(rules.allow).toContain('shell_exec(npm *)');
    const onDisk = JSON.parse(fs.readFileSync(process.env.KLYRO_CONFIG!, 'utf-8')) as { allow: string[] };
    expect(onDisk.allow).toEqual(['shell_exec(npm *)']);
  });
});
