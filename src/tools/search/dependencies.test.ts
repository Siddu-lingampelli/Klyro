import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { dependenciesTool } from './dependencies.js';
import type { ToolContext } from '../types.js';

let cwd: string;
let ctx: ToolContext;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-dep-'));
  ctx = { cwd, env: {} };
});
afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

describe('dependenciesTool', () => {
  it('reads npm dependencies from package.json', async () => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'demo',
      dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
      devDependencies: { vitest: '^4.0.0' },
    }));
    const r = await dependenciesTool.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ecosystem).toBe('npm');
    expect(r.value.source).toBe('package.json');
    const names = r.value.dependencies.map((d) => d.name);
    expect(names).toContain('react');
    expect(names).toContain('react-dom');
    expect(names).toContain('vitest');
    expect(r.value.dependencies.find((d) => d.name === 'react')?.version).toBe('^19.0.0');
  });

  it('reads Python dependencies from requirements.txt', async () => {
    await fs.writeFile(path.join(cwd, 'requirements.txt'),
      'django==4.2.7\nrequests>=2.31\n# comment\ncelery[redis]>=5.3\n');
    const r = await dependenciesTool.execute({ ecosystem: 'python' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ecosystem).toBe('python');
    const names = r.value.dependencies.map((d) => d.name);
    expect(names).toContain('django');
    expect(names).toContain('requests');
    expect(names).toContain('celery');
  });

  it('reads Go dependencies from go.mod (single-line and block form)', async () => {
    await fs.writeFile(path.join(cwd, 'go.mod'),
      `module example.com/x

go 1.22

require (
  github.com/foo/bar v1.2.3
  github.com/baz/qux v0.1.0 // indirect
)

require github.com/single/line v2.0.0
`);
    const r = await dependenciesTool.execute({ ecosystem: 'go' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.value.dependencies.map((d) => d.name);
    expect(names).toContain('github.com/foo/bar');
    expect(names).toContain('github.com/baz/qux');
    expect(names).toContain('github.com/single/line');
  });

  it('reads Rust dependencies from Cargo.toml', async () => {
    await fs.writeFile(path.join(cwd, 'Cargo.toml'),
      `[package]
name = "demo"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = "1.0"
serde_json = "1.0.50"
tokio = { version = "1.0", features = ["full"] }
`);
    const r = await dependenciesTool.execute({ ecosystem: 'rust' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.value.dependencies.map((d) => d.name);
    expect(names).toContain('serde');
    expect(names).toContain('serde_json');
    expect(names).toContain('tokio');
  });

  it('returns empty when no manifest is present', async () => {
    const r = await dependenciesTool.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dependencies).toEqual([]);
  });

  it('prefers npm over python when both manifests exist (auto mode)', async () => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'd', dependencies: { foo: '1' } }));
    await fs.writeFile(path.join(cwd, 'requirements.txt'), 'bar==1\n');
    const r = await dependenciesTool.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ecosystem).toBe('npm');
  });
});
