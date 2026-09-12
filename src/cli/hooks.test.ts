import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadHooks, runHook } from './hooks.js';

// Isolate HOME so the global ~/.klyro/hooks.json never leaks into tests.
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let fakeHome: string;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-hooks-home-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

function mkCwd(files?: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-hooks-cwd-'));
  if (files) {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf-8');
    }
  }
  return dir;
}

const nodeOk = `"${process.execPath}" -e "process.exit(0)"`;
const nodeFail = `"${process.execPath}" -e "console.error('nope-from-hook'); process.exit(1)"`;

describe('loadHooks', () => {
  it('returns [] when no hooks file exists', () => {
    const dir = mkCwd();
    try {
      expect(loadHooks(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for invalid JSON (never throws)', () => {
    const dir = mkCwd({ '.klyro/hooks.json': '{not json' });
    try {
      expect(loadHooks(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for schema-invalid content (never throws)', () => {
    const dir = mkCwd({ '.klyro/hooks.json': JSON.stringify({ hooks: [{ name: 'x' }] }) });
    try {
      expect(loadHooks(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads project hooks and merges global (project wins on name clash)', () => {
    fs.mkdirSync(path.join(fakeHome, '.klyro'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, '.klyro', 'hooks.json'),
      JSON.stringify({ hooks: [
        { name: 'shared', event: 'preToolUse', command: 'global-cmd' },
        { name: 'global-only', event: 'postToolUse', command: 'g' },
      ] }),
      'utf-8',
    );
    const dir = mkCwd({
      '.klyro/hooks.json': JSON.stringify({ hooks: [
        { name: 'shared', event: 'preToolUse', command: 'project-cmd' },
      ] }),
    });
    try {
      const hooks = loadHooks(dir);
      expect(hooks).toHaveLength(2);
      expect(hooks.find((h) => h.name === 'shared')?.command).toBe('project-cmd');
      expect(hooks.find((h) => h.name === 'global-only')).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runHook', () => {
  it('allow hook exit 0 resolves ok', async () => {
    const r = await runHook({ name: 'allow', event: 'preToolUse', command: nodeOk }, { toolName: 'read_file', input: {} });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it('deny hook exit 1 resolves not-ok with stderr', async () => {
    const r = await runHook({ name: 'deny', event: 'preToolUse', command: nodeFail }, { toolName: 'read_file', input: {} });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('nope-from-hook');
  });
});
