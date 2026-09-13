/**
 * Project bootstrap shared by `klyro init` and the REPL `/init`:
 * scan-seeded KLYRO.md (only when absent) + `.mcp.json` skeleton.
 * Never overwrites user files; returns created vs skipped lists.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface InitResult {
  created: string[];
  skipped: string[];
}

function captureStdout(): { release: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = ((c: string) => {
    out += String(c);
    return true;
  }) as typeof process.stdout.write;
  return {
    release: () => {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
      return out;
    },
  };
}

export async function initProject(cwd: string): Promise<InitResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const klyroMd = path.join(cwd, 'KLYRO.md');
  if (fs.existsSync(klyroMd)) {
    skipped.push('KLYRO.md (exists)');
  } else {
    const { runScan } = await import('./scan.js');
    const cap = captureStdout();
    try {
      await runScan({ cwd, json: false });
    } finally {
      // release even if scan throws — partial output still seeds the draft
    }
    const out = cap.release();
    fs.writeFileSync(
      klyroMd,
      `# KLYRO.md\n\nProject: ${cwd}\n\n## Stack\n\n${out.slice(0, 2000)}\n\n## Conventions\n\n- Prefer smallest change that solves the task.\n- Run verification after edits.\n`,
      'utf-8',
    );
    created.push('KLYRO.md');
  }
  const mcpJson = path.join(cwd, '.mcp.json');
  if (fs.existsSync(mcpJson)) {
    skipped.push('.mcp.json (exists)');
  } else {
    fs.writeFileSync(mcpJson, JSON.stringify({ mcpServers: {} }, null, 2) + '\n', 'utf-8');
    created.push('.mcp.json');
  }
  return { created, skipped };
}

export function nextStepsText(): string {
  return [
    'Next steps:',
    '  klyro login            # store provider key once (or set KLYRO_BASE_URL/_API_KEY/_MODEL)',
    '  klyro doctor           # verify toolchain, provider, sessions, sandbox',
    '  klyro agents           # list subagents (add yours in .klyro/agents/*.md)',
    '  klyro mcp add <n> <cmd># attach a tool server (or https:// URL for remote)',
  ].join('\n');
}
