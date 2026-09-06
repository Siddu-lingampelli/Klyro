import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { gitStatusTool } from './git-status.js';
import { gitLogTool } from './git-log.js';

describe('git tools', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-git-'));
    spawnSync('git', ['init'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 't@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: tmp });
    await fs.writeFile(path.join(tmp, 'a.txt'), 'hello', 'utf-8');
    spawnSync('git', ['add', '.'], { cwd: tmp });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmp });
  });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('git_status', async () => {
    const r = await gitStatusTool.execute({}, { cwd: tmp, env: {} });
    expect(r.ok).toBe(true);
  });

  it('git_log', async () => {
    const r = await gitLogTool.execute({ limit: 5 }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(true);
  });
});
