/**
 * Project map — high-level description of a repository.
 *
 * Goal: when an agent opens a repo for the first time, it should learn
 * "what kind of project is this" in one read. We detect:
 *   - language(s)              from file extensions
 *   - framework                from package.json / requirements.txt / go.mod
 *   - package manager          from lockfiles + scripts
 *   - test framework           from package.json scripts + devDependencies
 *   - build commands           from package.json scripts + Makefile
 *   - source directories       from convention + first-party markers
 *   - important config files   from a curated allow-list
 *
 * Output: ProjectMap (machine-readable) + formatProjectMap() (model-readable).
 *
 * Design constraints:
 *   - Single root-dir read, no subprocess calls (fast + hermetic).
 *   - Bounded output: at most MAX_SOURCE_DIRS source dirs, MAX_CONFIG_FILES
 *     config files, top-3 languages, top-3 frameworks.
 *   - Reuses IGNORED_DIRS from repo-map.ts so the two scanners agree on
 *     what to walk past.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo',
  'coverage', '.klyro', 'out', 'target', 'vendor', '__pycache__',
  '.cache', '.parcel-cache', '.vscode', '.idea',
]);

const MAX_SOURCE_DIRS = 8;
const MAX_CONFIG_FILES = 12;
const MAX_LANGUAGES = 3;
const MAX_FRAMEWORKS = 3;
const MAX_DEPS = 25;
const MAX_BYTES = 64 * 1024; // 64 KB per config file we read fully

const CONFIG_FILE_ALLOWLIST = new Set([
  'package.json', 'tsconfig.json', 'tsconfig.test.json', 'jsconfig.json',
  'vite.config.ts', 'vite.config.js', 'vitest.config.ts', 'vitest.config.js',
  'next.config.js', 'next.config.ts', 'next.config.mjs',
  'Cargo.toml', 'go.mod', 'requirements.txt', 'pyproject.toml', 'setup.py',
  'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'Makefile', 'CMakeLists.txt',
  '.eslintrc.json', '.eslintrc.js', '.prettierrc.json', '.editorconfig',
  'tailwind.config.js', 'tailwind.config.ts', 'postcss.config.js',
  'docker-compose.yml', 'Dockerfile', '.env.example',
  'README.md', 'LICENSE',
]);

/** Heuristic source dir candidates, ranked by how commonly they hold first-party code. */
const SOURCE_DIR_CANDIDATES = [
  'src', 'lib', 'app', 'pkg', 'cmd', 'internal',
  'src/main', 'src/lib', 'src/app', 'src/server', 'src/client',
  'lib/src', 'app/src',
];

export interface Dependency {
  name: string;
  version?: string;
}

export interface ProjectMap {
  root: string;
  language: string[];
  framework: string[];
  packageManager?: string;
  testFramework?: string;
  buildCommands: string[];
  sourceDirs: string[];
  configFiles: string[];
  dependencies: Dependency[];
  /** True when the repo has a package.json (Node/JS) anywhere up the tree. */
  hasPackageJson: boolean;
  /** True when the repo has a git working tree. */
  hasGit: boolean;
  /** Time the map was built. */
  generatedAt: string;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function readJsonSafe(p: string): Promise<Record<string, unknown> | null> {
  try {
    const s = await fs.stat(p);
    if (!s.isFile() || s.size > MAX_BYTES) return null;
    const raw = await fs.readFile(p, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readTextSafe(p: string, max = MAX_BYTES): Promise<string | null> {
  try {
    const s = await fs.stat(p);
    if (!s.isFile() || s.size > max) return null;
    return await fs.readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

/** Count file extensions in a directory (shallow, capped). */
async function countExtensions(
  root: string,
  caps: { dirs?: number; filesPerDir?: number } = {},
): Promise<Map<string, number>> {
  const dirs = caps.dirs ?? 200;
  const filesPerDir = caps.filesPerDir ?? 50;
  const extCounts = new Map<string, number>();
  let dirsVisited = 0;
  let stop = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (stop) return;
    if (dirsVisited >= dirs) { stop = true; return; }
    dirsVisited++;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    let files = 0;
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 6) await walk(full, depth + 1);
        if (stop) return;
      } else if (e.isFile()) {
        files++;
        if (files > filesPerDir) break;
        const ext = path.extname(e.name).toLowerCase();
        if (!ext) continue;
        extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
      }
    }
  }
  await walk(root, 0);
  return extCounts;
}

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java', '.kt': 'Kotlin', '.scala': 'Scala',
  '.rb': 'Ruby',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.hpp': 'C++',
  '.cs': 'C#', '.fs': 'F#',
  '.php': 'PHP',
  '.swift': 'Swift', '.m': 'Objective-C',
  '.sh': 'Shell', '.bash': 'Shell',
};

function extensionsToLanguages(extCounts: Map<string, number>): string[] {
  const langCounts = new Map<string, number>();
  for (const [ext, count] of extCounts) {
    const lang = EXT_TO_LANG[ext];
    if (!lang) continue;
    langCounts.set(lang, (langCounts.get(lang) ?? 0) + count);
  }
  return [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_LANGUAGES)
    .map(([l]) => l);
}

interface FrameworkSignature {
  name: string;
  /** Match: package.json has any of these in dependencies / devDependencies. */
  npmDeps?: string[];
  /** Match: file exists in repo root. */
  files?: string[];
  /** Match: requirements.txt contains this exact line (anchored). */
  pythonReq?: string[];
}

const FRAMEWORK_SIGNATURES: FrameworkSignature[] = [
  { name: 'Next.js',     npmDeps: ['next'],                       files: ['next.config.js', 'next.config.ts', 'next.config.mjs'] },
  { name: 'Nuxt',        npmDeps: ['nuxt'] },
  { name: 'Remix',       npmDeps: ['@remix-run/react', '@remix-run/node'] },
  { name: 'SvelteKit',   npmDeps: ['@sveltejs/kit'] },
  { name: 'Astro',       npmDeps: ['astro'] },
  { name: 'Express',     npmDeps: ['express'] },
  { name: 'Fastify',     npmDeps: ['fastify'] },
  { name: 'NestJS',      npmDeps: ['@nestjs/core'] },
  { name: 'Koa',         npmDeps: ['koa'] },
  { name: 'Hapi',        npmDeps: ['@hapi/hapi'] },
  { name: 'React',       npmDeps: ['react'] },
  { name: 'Vue',         npmDeps: ['vue'] },
  { name: 'Angular',     npmDeps: ['@angular/core'] },
  { name: 'Svelte',      npmDeps: ['svelte'] },
  { name: 'Solid',       npmDeps: ['solid-js'] },
  { name: 'Vite',        npmDeps: ['vite'],                       files: ['vite.config.ts', 'vite.config.js'] },
  { name: 'Vitest',      npmDeps: ['vitest'],                     files: ['vitest.config.ts', 'vitest.config.js'] },
  { name: 'Jest',        npmDeps: ['jest'] },
  { name: 'Mocha',       npmDeps: ['mocha'] },
  { name: 'Pytest',      pythonReq: ['pytest', 'pytest-asyncio', 'pytest-cov'] },
  { name: 'Django',      pythonReq: ['django'] },
  { name: 'Flask',       pythonReq: ['flask'] },
  { name: 'FastAPI',     pythonReq: ['fastapi'] },
  { name: 'Tornado',     pythonReq: ['tornado'] },
  { name: 'Rails',       files: ['Gemfile'] },
  { name: 'Spring',      files: ['pom.xml', 'build.gradle', 'build.gradle.kts'] },
  { name: 'Cargo',       files: ['Cargo.toml'] },
  { name: 'CMake',       files: ['CMakeLists.txt'] },
];

function detectFrameworks(
  pkg: Record<string, unknown> | null,
  filesInRoot: Set<string>,
  reqLines: string[],
): string[] {
  const npmDeps = new Set<string>();
  if (pkg) {
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const d = pkg[k];
      if (d && typeof d === 'object') {
        for (const name of Object.keys(d as Record<string, unknown>)) npmDeps.add(name);
      }
    }
  }
  const detected: { name: string; rank: number }[] = [];
  for (const sig of FRAMEWORK_SIGNATURES) {
    let rank = 0;
    if (sig.npmDeps) for (const d of sig.npmDeps) if (npmDeps.has(d)) { rank += 2; break; }
    if (sig.files) for (const f of sig.files) if (filesInRoot.has(f)) { rank += 3; break; }
    if (sig.pythonReq) for (const r of sig.pythonReq) if (reqLines.some((l) => l.toLowerCase().startsWith(r.toLowerCase()))) { rank += 2; break; }
    if (rank > 0) detected.push({ name: sig.name, rank });
  }
  return detected
    .sort((a, b) => b.rank - a.rank)
    .slice(0, MAX_FRAMEWORKS)
    .map((d) => d.name);
}

function detectPackageManager(root: string, pkg: Record<string, unknown> | null): string | undefined {
  // Lockfile order roughly maps to the most common PM per ecosystem.
  const checks: [string, string][] = [
    ['package-lock.json', 'npm'],
    ['yarn.lock',         'yarn'],
    ['pnpm-lock.yaml',    'pnpm'],
    ['bun.lockb',         'bun'],
    ['Cargo.lock',        'cargo'],
    ['poetry.lock',       'poetry'],
    ['Pipfile.lock',      'pipenv'],
    ['uv.lock',           'uv'],
    ['go.sum',            'go modules'],
  ];
  // Heuristic: lockfile presence is the strongest signal.
  // We do a sync existsFile check for each — they live in the root, so cheap.
  for (const [lock, pm] of checks) {
    // Avoid the async cost by re-using the root listing we already do.
    // (Caller threads the listing into detectFrameworks; here we re-stat directly.)
    try { require('node:fs').statSync(path.join(root, lock)); return pm; } catch { /* not present */ }
  }
  // Fall back: if package.json has a "packageManager" field, use it.
  if (pkg && typeof pkg.packageManager === 'string') {
    const m = /^([a-z]+)/i.exec(pkg.packageManager);
    if (m && m[1]) return m[1].toLowerCase();
  }
  return undefined;
}

function detectTestFramework(pkg: Record<string, unknown> | null): string | undefined {
  if (!pkg) return undefined;
  const dev = (pkg.devDependencies ?? {}) as Record<string, string>;
  if (dev.vitest || dev['@vitest/runner']) return 'Vitest';
  if (dev.jest) return 'Jest';
  if (dev.mocha) return 'Mocha';
  if (dev['@playwright/test']) return 'Playwright';
  if (dev.cypress) return 'Cypress';
  if (dev.tape) return 'Tape';
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  if (deps.vitest) return 'Vitest';
  if (deps.jest) return 'Jest';
  return undefined;
}

function extractBuildCommands(pkg: Record<string, unknown> | null, root: string): string[] {
  const out: string[] = [];
  if (pkg && typeof pkg.scripts === 'object' && pkg.scripts) {
    const scripts = pkg.scripts as Record<string, string>;
    for (const key of ['build', 'compile', 'prepare', 'start', 'dev', 'test', 'lint', 'typecheck']) {
      if (typeof scripts[key] === 'string') {
        out.push(`npm run ${key}  # ${scripts[key]}`);
      }
    }
  }
  // Makefile: pick the first `target:` block as a hint.
  // (Don't try to parse make fully — just surface the targets as a single hint.)
  try {
    const stat = require('node:fs').statSync(path.join(root, 'Makefile'));
    if (stat.isFile() && stat.size < MAX_BYTES) {
      const raw = require('node:fs').readFileSync(path.join(root, 'Makefile'), 'utf-8') as string;
      const targets = [...raw.matchAll(/^([a-zA-Z_][\w-]*)\s*:/gm)].map((m) => m[1]).slice(0, 6);
      if (targets.length) out.push(`make <target>  # targets: ${targets.join(', ')}`);
    }
  } catch { /* no Makefile */ }
  return out.slice(0, 8);
}

async function detectSourceDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of SOURCE_DIR_CANDIDATES) {
    const full = path.join(root, candidate);
    if (await exists(full)) {
      try {
        const s = await fs.stat(full);
        if (s.isDirectory()) found.push(candidate);
      } catch { /* race */ }
    }
    if (found.length >= MAX_SOURCE_DIRS) break;
  }
  return found;
}

async function listRootEntries(root: string): Promise<{ files: Set<string>; dirs: string[] }> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const files = new Set<string>();
    const dirs: string[] = [];
    for (const e of entries) {
      if (e.isFile()) files.add(e.name);
      else if (e.isDirectory()) dirs.push(e.name);
    }
    return { files, dirs };
  } catch {
    return { files: new Set(), dirs: [] };
  }
}

function extractDependencies(pkg: Record<string, unknown> | null): Dependency[] {
  if (!pkg) return [];
  const out: Dependency[] = [];
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  for (const [name, version] of Object.entries(deps)) {
    if (typeof version === 'string') out.push({ name, version });
    else out.push({ name });
    if (out.length >= MAX_DEPS) break;
  }
  return out;
}

/** Build a project map for the repo rooted at `root`. */
export async function buildProjectMap(root: string): Promise<ProjectMap> {
  const { files: rootFiles, dirs: rootDirs } = await listRootEntries(root);

  const pkg = await readJsonSafe(path.join(root, 'package.json'));
  const hasPackageJson = pkg !== null;

  const reqText = await readTextSafe(path.join(root, 'requirements.txt'));
  const reqLines = reqText ? reqText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];

  // Walk the tree shallowly for extensions.
  const extCounts = await countExtensions(root);

  // Source dirs by convention.
  const sourceDirs = await detectSourceDirs(root);

  // Important config files (allowlist only, root + src).
  const configFiles: string[] = [];
  for (const name of CONFIG_FILE_ALLOWLIST) {
    if (rootFiles.has(name)) configFiles.push(name);
    if (configFiles.length >= MAX_CONFIG_FILES) break;
  }
  if (rootDirs.includes('src')) {
    for (const name of ['tsconfig.json', 'package.json', 'README.md']) {
      if (await exists(path.join(root, 'src', name)) && !configFiles.includes(`src/${name}`)) {
        configFiles.push(`src/${name}`);
        if (configFiles.length >= MAX_CONFIG_FILES) break;
      }
    }
  }

  const framework = detectFrameworks(pkg, rootFiles, reqLines);
  const packageManager = detectPackageManager(root, pkg);
  const testFramework = detectTestFramework(pkg);
  const buildCommands = extractBuildCommands(pkg, root);
  const dependencies = extractDependencies(pkg);
  const language = extensionsToLanguages(extCounts);
  const hasGit = await exists(path.join(root, '.git'));

  return {
    root,
    language,
    framework,
    packageManager,
    testFramework,
    buildCommands,
    sourceDirs,
    configFiles,
    dependencies,
    hasPackageJson,
    hasGit,
    generatedAt: new Date().toISOString(),
  };
}

/** Render a ProjectMap as a compact, model-friendly block. */
export function formatProjectMap(m: ProjectMap): string {
  const lines: string[] = [];
  lines.push('# Project map');
  if (m.language.length) lines.push(`- Language: ${m.language.join(', ')}`);
  if (m.framework.length) lines.push(`- Framework: ${m.framework.join(', ')}`);
  if (m.packageManager) lines.push(`- Package manager: ${m.packageManager}`);
  if (m.testFramework) lines.push(`- Test framework: ${m.testFramework}`);
  if (m.sourceDirs.length) lines.push(`- Source dirs: ${m.sourceDirs.join(', ')}`);
  if (m.configFiles.length) lines.push(`- Important config: ${m.configFiles.join(', ')}`);
  if (m.buildCommands.length) {
    lines.push('- Build / scripts:');
    for (const c of m.buildCommands) lines.push(`  - ${c}`);
  }
  if (m.dependencies.length) {
    lines.push(`- Direct dependencies (top ${m.dependencies.length}):`);
    for (const d of m.dependencies) {
      lines.push(`  - ${d.name}${d.version ? `@${d.version}` : ''}`);
    }
  }
  if (!m.hasGit) lines.push('- Note: not a git working tree');
  return lines.join('\n');
}
