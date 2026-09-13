import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadCustomAgents } from './custom-agents.js';

describe('custom agent files', () => {
  it('loads typed definitions with prompt body', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-agt-'));
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      fs.mkdirSync(path.join(cwd, '.klyro', 'agents'), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, '.klyro', 'agents', 'writer.md'),
        '---\ndescription: Writes docs\ntools: read_file, write_file\nreadonly: false\nmaxSteps: 40\n---\nYou are a docs specialist. $EXTRA\n',
        'utf-8',
      );
      const all = loadCustomAgents(cwd);
      const w = all.find((a) => a.id === 'writer');
      expect(w?.description).toBe('Writes docs');
      expect(w?.allowedTools).toEqual(['read_file', 'write_file']);
      expect(w?.maxSteps).toBe(40);
      expect(w?.prompt).toContain('docs specialist');
      expect(w?.source).toBe('project');
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects bad ids, allows constraints-only files, never throws on missing dirs', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-agt-'));
    try {
      fs.mkdirSync(path.join(cwd, '.klyro', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.klyro', 'agents', 'bad name!.md'), '---\ndescription: x\n---\nbody\n', 'utf-8');
      // Frontmatter-only file: valid constraints-only agent (no prompt body).
      fs.writeFileSync(path.join(cwd, '.klyro', 'agents', 'empty.md'), '---\ndescription: x\nreadonly: true\n---\n', 'utf-8');
      const all = loadCustomAgents(cwd);
      expect(all.map((a) => a.id)).toEqual(['empty']);
      expect(all[0]?.prompt).toBeUndefined();
      expect(all[0]?.readonly).toBe(true);
      expect(loadCustomAgents(path.join(cwd, 'nope'))).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
