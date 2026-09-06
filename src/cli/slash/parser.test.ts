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

  it('parses /plan, /login, /logout, /init', () => {
    expect(parse('/plan').kind).toBe('plan');
    expect(parse('/login').kind).toBe('login');
    expect(parse('/logout').kind).toBe('logout');
    expect(parse('/init').kind).toBe('init');
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
