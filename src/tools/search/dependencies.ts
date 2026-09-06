/**
 * dependencies — surface direct dependencies of the repo.
 *
 * Reads package.json / requirements.txt / go.mod / Cargo.toml / pyproject.toml
 * and returns the first-party name + version list. Does NOT recurse into
 * transitive deps (that's a "lockfile parse" feature, not Level 6).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveWithinCwd } from '../../policy/path-guard.js';
import { safe } from '../normalize.js';

const InputSchema = z.object({
  cwd: z.string().optional(),
  ecosystem: z.enum(['auto', 'npm', 'python', 'go', 'rust']).optional().describe('Force a specific ecosystem; default auto-detect'),
  maxResults: z.number().int().min(1).max(500).optional().describe('Cap (default 200)'),
});

const DEFAULT_MAX = 200;
const MAX_BYTES = 64 * 1024;

export interface Dep {
  name: string;
  version?: string;
  ecosystem: 'npm' | 'python' | 'go' | 'rust';
}

export interface DependenciesOutput {
  ecosystem?: string;
  dependencies: Dep[];
  source?: string;
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    const s = await fs.stat(p);
    if (!s.isFile() || s.size > MAX_BYTES) return null;
    return JSON.parse(await fs.readFile(p, 'utf-8')) as Record<string, unknown>;
  } catch { return null; }
}

async function readText(p: string): Promise<string | null> {
  try {
    const s = await fs.stat(p);
    if (!s.isFile() || s.size > MAX_BYTES) return null;
    return await fs.readFile(p, 'utf-8');
  } catch { return null; }
}

function parseNpmDeps(pkg: Record<string, unknown>): Dep[] {
  const out: Dep[] = [];
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const d = pkg[key];
    if (!d || typeof d !== 'object') continue;
    const section = d as Record<string, string>;
    for (const [name, version] of Object.entries(section)) {
      if (typeof version === 'string') out.push({ name, version, ecosystem: 'npm' });
      else out.push({ name, ecosystem: 'npm' });
    }
  }
  return out;
}

function parsePythonReq(text: string): Dep[] {
  const out: Dep[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith('-')) continue;
    // PEP 508: name [@ url] [version_spec] [; markers]
    const m = /^([A-Za-z0-9_.\-]+)(?:\s*([@=<>~!]+)\s*([^\s;]+))?/.exec(l);
    if (!m || !m[1]) continue;
    const name = m[1];
    const version = m[3];
    const dep: Dep = version ? { name, version, ecosystem: 'python' } : { name, ecosystem: 'python' };
    out.push(dep);
  }
  return out;
}

function parseGoMod(text: string): Dep[] {
  const out: Dep[] = [];
  // require ( ... ) block, or single-line: require foo v1.2.3
  const block = /\brequire\s+\(([\s\S]*?)\)/g;
  let m: RegExpExecArray | null;
  while ((m = block.exec(text)) !== null) {
    for (const line of m[1]!.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('//')) continue;
      const parts = t.split(/\s+/);
      if (parts.length >= 2 && parts[0]) out.push({ name: parts[0], version: parts[1], ecosystem: 'go' });
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    const m2 = /^require\s+([^\s]+)\s+(\S+)/.exec(t);
    if (m2 && m2[1] && m2[2]) out.push({ name: m2[1], version: m2[2], ecosystem: 'go' });
  }
  return out;
}

function parseCargo(text: string): Dep[] {
  const out: Dep[] = [];
  let inDeps = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '[dependencies]') { inDeps = true; continue; }
    if (t.startsWith('[') && t !== '[dependencies]') { inDeps = false; continue; }
    if (!inDeps) continue;
    if (!t || t.startsWith('#')) continue;
    const m = /^([A-Za-z0-9_\-]+)\s*=\s*(?:"([^"]+)"|'([^']+)'|(\{[\s\S]*?\}))/.exec(t);
    if (m && m[1]) {
      const version = m[2] ?? m[3] ?? undefined;
      out.push({ name: m[1], version, ecosystem: 'rust' });
    }
  }
  return out;
}

export const dependenciesTool = defineTool({
  name: 'dependencies',
  description:
    'List direct dependencies of the repo (npm, Python, Go, or Rust). Use to understand the project\'s surface area without reading every manifest file.',
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    return safe(async () => {
      const base = input.cwd ? resolveWithinCwd(ctx.cwd, input.cwd).resolved : ctx.cwd;
      const max = input.maxResults ?? DEFAULT_MAX;
      const want = input.ecosystem ?? 'auto';

      const tryNpm = async (): Promise<{ source: string; deps: Dep[] } | null> => {
        const pkg = await readJson(path.join(base, 'package.json'));
        if (!pkg) return null;
        return { source: 'package.json', deps: parseNpmDeps(pkg) };
      };
      const tryPy = async (): Promise<{ source: string; deps: Dep[] } | null> => {
        const t = await readText(path.join(base, 'requirements.txt'));
        if (t) return { source: 'requirements.txt', deps: parsePythonReq(t) };
        const pp = await readText(path.join(base, 'pyproject.toml'));
        if (pp) {
          // minimal: only the [project] dependencies = [...] form
          const m = /\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/.exec(pp);
          if (m && m[1]) {
            const items = m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
            return { source: 'pyproject.toml', deps: items.map((name) => ({ name, ecosystem: 'python' as const })) };
          }
        }
        return null;
      };
      const tryGo = async (): Promise<{ source: string; deps: Dep[] } | null> => {
        const t = await readText(path.join(base, 'go.mod'));
        if (!t) return null;
        return { source: 'go.mod', deps: parseGoMod(t) };
      };
      const tryCargo = async (): Promise<{ source: string; deps: Dep[] } | null> => {
        const t = await readText(path.join(base, 'Cargo.toml'));
        if (!t) return null;
        return { source: 'Cargo.toml', deps: parseCargo(t) };
      };

      let picked: { source: string; deps: Dep[] } | null = null;
      if (want === 'npm') picked = await tryNpm();
      else if (want === 'python') picked = await tryPy();
      else if (want === 'go') picked = await tryGo();
      else if (want === 'rust') picked = await tryCargo();
      else {
        picked = (await tryNpm()) ?? (await tryPy()) ?? (await tryGo()) ?? (await tryCargo());
      }

      if (!picked) {
        return { dependencies: [] } satisfies DependenciesOutput;
      }
      return {
        ecosystem: picked.deps[0]?.ecosystem,
        source: picked.source,
        dependencies: picked.deps.slice(0, max),
      } satisfies DependenciesOutput;
    });
  },
});

export type DependenciesInput = z.infer<typeof InputSchema>;
