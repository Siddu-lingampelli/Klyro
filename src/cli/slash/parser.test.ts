import { describe, it, expect } from 'vitest';
import { parse, listCommands } from './parser.js';

describe('slash command parser', () => {
  it('treats non-slash input as a prompt', () => {
    expect(parse('hello world')).toEqual({ kind: 'prompt', text: 'hello world' });
  });

  it('trims whitespace around prompts', () => {
    expect(parse('   hi   ')).toEqual({ kind: 'prompt', text: 'hi' });
  });

  it('parses /clear', () => {
    expect(parse('/clear')).toEqual({ kind: 'clear' });
  });

  it('parses /compact', () => {
    expect(parse('/compact')).toEqual({ kind: 'compact' });
  });

  it('parses /model with an argument', () => {
    expect(parse('/model gpt-4o-mini')).toEqual({ kind: 'model', model: 'gpt-4o-mini' });
  });

  it('parses /m as a model alias', () => {
    expect(parse('/m claude-opus-5')).toEqual({ kind: 'model', model: 'claude-opus-5' });
  });

  it('returns model with empty string for /model with no argument (shows current)', () => {
    expect(parse('/model')).toEqual({ kind: 'model', model: '' });
  });

  it('parses /provider with and without argument', () => {
    expect(parse('/provider')).toEqual({ kind: 'provider', provider: '' });
    expect(parse('/provider anthropic')).toEqual({ kind: 'provider', provider: 'anthropic' });
  });

  it('parses /effort with and without argument', () => {
    expect(parse('/effort')).toEqual({ kind: 'effort', level: '' });
    expect(parse('/effort high')).toEqual({ kind: 'effort', level: 'high' });
  });

  it('parses /compact with optional focus', () => {
    expect(parse('/compact')).toEqual({ kind: 'compact', focus: undefined });
    expect(parse('/compact focus on tests')).toEqual({ kind: 'compact', focus: 'focus on tests' });
  });

  it('parses /plan with optional task, /login, /logout, /init', () => {
    expect(parse('/plan')).toEqual({ kind: 'plan', task: undefined });
    expect(parse('/plan fix auth')).toEqual({ kind: 'plan', task: 'fix auth' });
    expect(parse('/login').kind).toBe('login');
    expect(parse('/logout').kind).toBe('logout');
    expect(parse('/init').kind).toBe('init');
  });

  it('parses P1 session commands', () => {
    expect(parse('/new').kind).toBe('new');
    expect(parse('/resume')).toEqual({ kind: 'resume', id: undefined });
    expect(parse('/resume abc123')).toEqual({ kind: 'resume', id: 'abc123' });
    expect(parse('/sessions').kind).toBe('sessions');
    expect(parse('/rename my task')).toEqual({ kind: 'rename', name: 'my task' });
    expect(parse('/fork')).toEqual({ kind: 'fork', prompt: undefined });
    expect(parse('/branch feat')).toEqual({ kind: 'branch', name: 'feat' });
    expect(parse('/export')).toEqual({ kind: 'export', file: undefined });
    expect(parse('/copy')).toEqual({ kind: 'copy', n: undefined });
    expect(parse('/quit').kind).toBe('quit');
    expect(parse('/exit').kind).toBe('quit');
  });

  it('parses P1 model/provider commands', () => {
    expect(parse('/models').kind).toBe('models');
    expect(parse('/fast')).toEqual({ kind: 'fast', state: '' });
    expect(parse('/fast on')).toEqual({ kind: 'fast', state: 'on' });
    expect(parse('/todos').kind).toBe('todos');
  });

  it('parses P1 permission commands', () => {
    expect(parse('/permissions').kind).toBe('permissions');
    expect(parse('/mode')).toEqual({ kind: 'mode', mode: '' });
    expect(parse('/mode yolo')).toEqual({ kind: 'mode', mode: 'yolo' });
    expect(parse('/sandbox')).toEqual({ kind: 'sandbox', policy: '' });
    expect(parse('/approve').kind).toBe('approve');
    expect(parse('/deny').kind).toBe('deny');
  });

  it('parses P1 auth/lifecycle commands', () => {
    expect(parse('/auth').kind).toBe('auth');
    expect(parse('/update').kind).toBe('update');
    expect(parse('/cancel').kind).toBe('cancel');
    expect(parse('/shell ls')).toEqual({ kind: 'shell', command: 'ls' });
    expect(parse('/mention src/index.ts')).toEqual({ kind: 'mention', path: 'src/index.ts' });
    expect(parse('/tools').kind).toBe('tools');
    expect(parse('/settings').kind).toBe('settings');
  });

  it('parses ! and @ aliases', () => {
    expect(parse('!ls -la')).toEqual({ kind: 'shell', command: 'ls -la' });
    expect(parse('@src/index.ts')).toEqual({ kind: 'mention', path: 'src/index.ts' });
  });

  it('parses /diff', () => {
    expect(parse('/diff')).toEqual({ kind: 'diff' });
  });

  it('parses /status', () => {
    expect(parse('/status')).toEqual({ kind: 'status' });
  });

  it('parses /quit and aliases', () => {
    expect(parse('/quit').kind).toBe('quit');
    expect(parse('/exit').kind).toBe('quit');
    expect(parse('/q').kind).toBe('quit');
  });

  it('parses /help and ?', () => {
    expect(parse('/help').kind).toBe('help');
    expect(parse('/?').kind).toBe('help');
  });

  it('returns unknown for unrecognized commands', () => {
    expect(parse('/wat')).toEqual({ kind: 'unknown', raw: '/wat' });
  });

  it('case-insensitive command names', () => {
    expect(parse('/CLEAR').kind).toBe('clear');
    expect(parse('/STATUS').kind).toBe('status');
  });

  it('listCommands returns the supported set', () => {
    const cmds = listCommands();
    expect(cmds).toContain('clear');
    expect(cmds).toContain('quit');
    expect(cmds).toContain('model');
    expect(cmds.length).toBeGreaterThanOrEqual(7);
  });
});
