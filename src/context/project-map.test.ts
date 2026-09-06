import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildProjectMap, formatProjectMap, IGNORED_DIRS } from './project-map.js';

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-pmap-'));
});

describe('buildProjectMap', () => {
  it('returns a minimal map for an empty directory', async () => {
    const m = await buildProjectMap(cwd);
    expect(m.root).toBe(cwd);
    expect(m.language).toEqual([]);
    expect(m.framework).toEqual([]);
    expect(m.packageManager).toBeUndefined();
    expect(m.testFramework).toBeUndefined();
    expect(m.buildCommands).toEqual([]);
    expect(m.sourceDirs).toEqual([]);
    expect(m.dependencies).toEqual([]);
    expect(m.hasPackageJson).toBe(false);
    expect(m.hasGit).toBe(false);
    expect(m.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('detects TypeScript + a React + Vite + Vitest stack', async () => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'demo',
      version: '0.0.0',
      scripts: { build: 'vite build', test: 'vitest run', dev: 'vite' },
      dependencies: { react: '^19.0.0' },
      devDependencies: { vite: '^7.0.0', vitest: '^4.0.0', typescript: '^5.0.0' },
    }));
    await fs.mkdir(path.join(cwd, 'src'));
    await fs.writeFile(path.join(cwd, 'src/index.ts'), 'export const x = 1;\n');
    await fs.writeFile(path.join(cwd, 'src/app.tsx'), 'export const App = () => null;\n');
    await fs.writeFile(path.join(cwd, 'tsconfig.json'), '{}');
    await fs.writeFile(path.join(cwd, 'vite.config.ts'), 'export default {};\n');
    await fs.writeFile(path.join(cwd, 'README.md'), '# demo');

    const m = await buildProjectMap(cwd);
    expect(m.hasPackageJson).toBe(true);
    expect(m.language).toContain('TypeScript');
    expect(m.framework).toEqual(expect.arrayContaining(['React', 'Vite', 'Vitest']));
    expect(m.testFramework).toBe('Vitest');
    expect(m.sourceDirs).toContain('src');
    expect(m.configFiles).toEqual(expect.arrayContaining(['package.json', 'tsconfig.json', 'vite.config.ts', 'README.md']));
    expect(m.dependencies.find((d) => d.name === 'react')).toBeDefined();
    expect(m.buildCommands.some((c) => c.startsWith('npm run build'))).toBe(true);
  });

  it('detects Python project from requirements.txt + Django', async () => {
    await fs.writeFile(path.join(cwd, 'requirements.txt'),
      'django==4.2\npsycopg2-binary==2.9\n# comment\ncelery>=5.0\n');
    await fs.mkdir(path.join(cwd, 'app'));
    await fs.writeFile(path.join(cwd, 'app/main.py'), 'print("hi")\n');
    const m = await buildProjectMap(cwd);
    expect(m.language).toContain('Python');
    expect(m.framework).toContain('Django');
    expect(m.sourceDirs).toContain('app');
    expect(m.hasPackageJson).toBe(false);
  });

  it('detects Rust project from Cargo.toml + source/ dirs', async () => {
    await fs.writeFile(path.join(cwd, 'Cargo.toml'),
      '[package]\nname = "demo"\nedition = "2021"\n[dependencies]\nserde = "1"\n');
    await fs.mkdir(path.join(cwd, 'src'));
    await fs.writeFile(path.join(cwd, 'src/main.rs'), 'fn main() {}\n');
    const m = await buildProjectMap(cwd);
    expect(m.language).toContain('Rust');
    expect(m.framework).toContain('Cargo');
    expect(m.sourceDirs).toContain('src');
    expect(m.configFiles).toContain('Cargo.toml');
  });

  it('detects packageManager field when no lockfile', async () => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'demo', packageManager: 'pnpm@9.0.0', scripts: { build: 'tsc' },
    }));
    const m = await buildProjectMap(cwd);
    expect(m.packageManager).toBe('pnpm');
  });

  it('detects yarn via lockfile', async () => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'demo' }));
    await fs.writeFile(path.join(cwd, 'yarn.lock'), '');
    const m = await buildProjectMap(cwd);
    expect(m.packageManager).toBe('yarn');
  });

  it('skips ignored directories when counting extensions', async () => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'demo' }));
    await fs.mkdir(path.join(cwd, 'node_modules'));
    await fs.writeFile(path.join(cwd, 'node_modules/whatever.ts'), 'export const x = 1;\n');
    await fs.mkdir(path.join(cwd, 'src'));
    await fs.writeFile(path.join(cwd, 'src/a.py'), 'x = 1\n');
    const m = await buildProjectMap(cwd);
    // The .ts inside node_modules must be skipped, the .py in src must be seen.
    expect(m.language).toContain('Python');
    expect(m.language).not.toContain('TypeScript');
  });

  it('caches importable fields: config files capped at MAX_CONFIG_FILES', async () => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'demo' }));
    // 20 random files in root
    for (let i = 0; i < 20; i++) {
      await fs.writeFile(path.join(cwd, `file${i}.json`), '{}');
    }
    const m = await buildProjectMap(cwd);
    expect(m.configFiles.length).toBeLessThanOrEqual(12);
  });

  it('sets hasGit=true when .git is present', async () => {
    await fs.mkdir(path.join(cwd, '.git'));
    const m = await buildProjectMap(cwd);
    expect(m.hasGit).toBe(true);
  });
});

describe('formatProjectMap', () => {
  it('renders a coherent outline', async () => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'demo',
      packageManager: 'pnpm@9.0.0',
      scripts: { build: 'tsc', test: 'vitest run' },
      devDependencies: { vitest: '^4.0.0' },
      dependencies: { react: '^19.0.0' },
    }));
    await fs.writeFile(path.join(cwd, 'pnpm-lock.yaml'), '');
    const m = await buildProjectMap(cwd);
    const text = formatProjectMap(m);
    expect(text).toContain('# Project map');
    expect(text).toContain('Package manager: pnpm');
    expect(text).toContain('Test framework: Vitest');
    expect(text).toContain('Build / scripts:');
    expect(text).toContain('npm run build');
    expect(text).toContain('react@^19.0.0');
  });

  it('omits sections when fields are empty', async () => {
    const m = await buildProjectMap(cwd);
    const text = formatProjectMap(m);
    expect(text).toBe('# Project map\n- Note: not a git working tree');
  });
});

describe('IGNORED_DIRS', () => {
  it('includes .klyro', () => {
    expect(IGNORED_DIRS.has('.klyro')).toBe(true);
  });
});
