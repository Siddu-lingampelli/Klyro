import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseFrontmatter, parseList, expandArgs, loadCustomCommands, listCompletableFiles } from './custom.js';

describe('custom command files', () => {
  it('parses frontmatter + body', () => {
    const { data, body } = parseFrontmatter('---\nname: Ship It\ndescription: do the thing\n---\nRun $1 with $@\n');
    expect(data['name']).toBe('Ship It');
    expect(body).toBe('Run $1 with $@\n');
  });

  it('expands $1..$9 and $@', () => {
    expect(expandArgs('a $1 b $2 c $@', ['x', 'y'])).toBe('a x b y c x y');
    expect(expandArgs('a $3', ['x'])).toBe('a ');
  });

  it('loads project commands with global fallback and clash priority', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-cmd-'));
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      fs.mkdirSync(path.join(home, '.klyro', 'commands'), { recursive: true });
      fs.writeFileSync(path.join(home, '.klyro', 'commands', 'deploy.md'), '---\ndescription: global deploy\n---\ndeploy global $@\n');
      fs.writeFileSync(path.join(home, '.klyro', 'commands', 'shared.md'), '---\ndescription: global\n---\nglobal body\n');
      fs.mkdirSync(path.join(cwd, '.klyro', 'commands'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.klyro', 'commands', 'shared.md'), '---\ndescription: project\n---\nproject body\n');
      const all = loadCustomCommands(cwd);
      expect(all.find((c) => c.name === 'deploy')?.source).toBe('global');
      expect(all.find((c) => c.name === 'shared')?.body).toBe('project body');
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('parseList handles bracket, comma, and dash forms', () => {
    expect(parseList('[a, b]')).toEqual(['a', 'b']);
    expect(parseList('a, b')).toEqual(['a', 'b']);
    expect(parseList('- a\n- b')).toEqual(['a', 'b']);
  });

  it('listCompletableFiles walks, skips ignored dirs, marks directories', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-idx-'));
    try {
      fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'x');
      fs.mkdirSync(path.join(cwd, 'node_modules', 'dep'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'node_modules', 'dep', 'i.js'), 'x');
      const files = listCompletableFiles(cwd);
      expect(files).toContain('src/');
      expect(files).toContain('src/a.ts');
      expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
