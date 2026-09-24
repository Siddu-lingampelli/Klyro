import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDoctor, describeKeyBytes } from './doctor.js';

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

  it('includes npm/PATH/ripgrep/Terminal/Proxy rows (1.5)', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-doctor-env-'));
    try {
      const { json } = await captureJson(cwd);
      const names = (json['checks'] as { name: string }[]).map((c) => c.name);
      for (const n of ['npm', 'PATH', 'ripgrep', 'Terminal', 'Proxy']) {
        expect(names).toContain(n);
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});


describe('describeKeyBytes (doctor --keys probe)', () => {
  it('names arrows, paging, home/end', () => {
    expect(describeKeyBytes(Buffer.from('\x1b[A', 'latin1'))).toMatch(/Up arrow/);
    expect(describeKeyBytes(Buffer.from('\x1b[B', 'latin1'))).toMatch(/Down arrow/);
    expect(describeKeyBytes(Buffer.from('\x1b[5~', 'latin1'))).toMatch(/PageUp/);
    expect(describeKeyBytes(Buffer.from('\x1b[6~', 'latin1'))).toMatch(/PageDown/);
    expect(describeKeyBytes(Buffer.from('\x1b[H', 'latin1'))).toMatch(/Home/);
    expect(describeKeyBytes(Buffer.from('\x1b[F', 'latin1'))).toMatch(/End/);
  });

  it('names Ctrl+P/N, paste markers, and wheel events', () => {
    expect(describeKeyBytes(Buffer.from('\x10', 'latin1'))).toMatch(/Ctrl\+P/);
    expect(describeKeyBytes(Buffer.from('\x0e', 'latin1'))).toMatch(/Ctrl\+N/);
    expect(describeKeyBytes(Buffer.from('\x1b[200~', 'latin1'))).toMatch(/START/);
    expect(describeKeyBytes(Buffer.from('\x1b[201~', 'latin1'))).toMatch(/END/);
    expect(describeKeyBytes(Buffer.from('\x1b[<64;10;20M', 'latin1'))).toMatch(/wheel up/);
    expect(describeKeyBytes(Buffer.from('\x1b[<65;10;20M', 'latin1'))).toMatch(/wheel down/);
    expect(describeKeyBytes(Buffer.from('\x1b[<0;10;20M', 'latin1'))).toMatch(/click\/drag/);
  });

  it('flags lone ESC as a possible split sequence', () => {
    expect(describeKeyBytes(Buffer.from('\x1b', 'latin1'))).toMatch(/lone/);
    expect(describeKeyBytes(Buffer.from('hello', 'utf-8'))).toMatch(/Printable/);
  });
});
