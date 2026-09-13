/**
 * Tests for src/mcp/config.ts — pure env expansion, timeout clamping, and
 * empty-name skipping. File-backed tests use temp dirs; the real global
 * `~/.klyro/mcp.json` (if any) is tolerated by asserting only on our names.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expandEnv, loadMcpServers, MAX_MCP_TIMEOUT_MS, addProjectServer, removeProjectServer } from './config.js';

describe('expandEnv', () => {
  it('expands ${env:VAR} from process.env', () => {
    process.env['KLYRO_MCP_TEST_TOKEN'] = 'abc123';
    try {
      expect(expandEnv('prefix-${env:KLYRO_MCP_TEST_TOKEN}-suffix')).toBe('prefix-abc123-suffix');
    } finally {
      delete process.env['KLYRO_MCP_TEST_TOKEN'];
    }
  });

  it('expands unset variables to empty string (documented silent empty expansion)', () => {
    delete process.env['KLYRO_MCP_TEST_DEFINITELY_UNSET'];
    expect(expandEnv('a-${env:KLYRO_MCP_TEST_DEFINITELY_UNSET}-b')).toBe('a--b');
  });

  it('leaves non-matching text alone', () => {
    expect(expandEnv('plain ${nope} $VAR')).toBe('plain ${nope} $VAR');
  });
});

function writeProject(cwd: string, servers: Record<string, unknown>): void {
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: servers }), 'utf-8');
}

describe('loadMcpServers', () => {
  it('clamps timeoutMs to MAX_MCP_TIMEOUT_MS instead of rejecting', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-mcp-cfg-'));
    writeProject(dir, {
      big: { command: 'x', policy: { allowTools: ['t'], timeoutMs: 999_999_999 } },
      normal: { command: 'y', policy: { allowTools: ['t'], timeoutMs: 1234 } },
    });
    const cfg = loadMcpServers(dir);
    expect(cfg.servers['big']?.policy?.timeoutMs).toBe(MAX_MCP_TIMEOUT_MS);
    expect(cfg.servers['big']?.policy?.timeoutMs).toBeLessThanOrEqual(600_000);
    expect(cfg.servers['normal']?.policy?.timeoutMs).toBe(1234);
    expect(cfg.sources['big']).toBe('project');
  });

  it('skips empty server names silently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-mcp-cfg-'));
    writeProject(dir, {
      '': { command: 'x' },
      ok: { command: 'y' },
    });
    const cfg = loadMcpServers(dir);
    expect(cfg.servers['ok']?.command).toBe('y');
    expect('' in cfg.servers).toBe(false);
  });

  it('expands env references in loaded specs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-mcp-cfg-'));
    process.env['KLYRO_MCP_TEST_KEY'] = 'sekret';
    try {
      writeProject(dir, { s: { command: 'x', env: { TOKEN: '${env:KLYRO_MCP_TEST_KEY}' } } });
      const cfg = loadMcpServers(dir);
      expect(cfg.servers['s']?.env?.['TOKEN']).toBe('sekret');
    } finally {
      delete process.env['KLYRO_MCP_TEST_KEY'];
    }
  });
});

describe('addProjectServer / removeProjectServer', () => {
  it('round-trips a server through .mcp.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-mcp-add-'));
    addProjectServer(dir, 'srv', { command: 'node', args: ['s.js'] });
    expect(loadMcpServers(dir).servers['srv']?.command).toBe('node');
    expect(removeProjectServer(dir, 'srv')).toBe(true);
    expect(loadMcpServers(dir).servers['srv']).toBeUndefined();
    expect(removeProjectServer(dir, 'srv')).toBe(false);
  });

  it('rejects bad names, bad specs, and duplicates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-mcp-add-'));
    expect(() => addProjectServer(dir, 'bad name!', { command: 'x' })).toThrow(/invalid server name/);
    expect(() => addProjectServer(dir, 'ok', { args: [] })).toThrow(/invalid server spec/);
    addProjectServer(dir, 'dup', { command: 'x' });
    expect(() => addProjectServer(dir, 'dup', { command: 'y' })).toThrow(/already configured/);
  });
});
