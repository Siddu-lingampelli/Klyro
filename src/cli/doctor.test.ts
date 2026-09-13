import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDoctor } from './doctor.js';

afterEach(() => {
  vi.restoreAllMocks();
});

async function captureJson(cwd: string): Promise<{ code: number; json: Record<string, unknown> }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const code = await runDoctor({ json: true, cwd });
  spy.mockRestore();
  return { code, json: JSON.parse(chunks.join('')) as Record<string, unknown> };
}

describe('doctor trust + mcp rows', () => {
  it('JSON output contains mcp/trust keys and check rows (backward compatible)', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-doctor-'));
    try {
      const { json } = await captureJson(cwd);
      // New top-level keys (additive — `ok`/`checks` shape preserved).
      expect(json).toHaveProperty('ok');
      expect(json).toHaveProperty('checks');
      expect(json).toHaveProperty('mcp');
      expect(json).toHaveProperty('trust');
      const checks = json['checks'] as { name: string }[];
      expect(checks.map((c) => c.name)).toContain('MCP servers');
      expect(checks.map((c) => c.name)).toContain('Trust stores');
      expect(checks.map((c) => c.name)).toContain('Sandbox');
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports project vs global MCP server counts', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-doctor-mcp-'));
    try {
      await fs.writeFile(
        path.join(cwd, '.mcp.json'),
        JSON.stringify({ mcpServers: { proj: { command: 'node' } } }),
        'utf-8',
      );
      const { json } = await captureJson(cwd);
      const checks = json['checks'] as { name: string; detail: string }[];
      const row = checks.find((c) => c.name === 'MCP servers');
      expect(row).toBeDefined();
      expect(row?.detail).toMatch(/1 servers \(global \d+\/project \d+\)/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
