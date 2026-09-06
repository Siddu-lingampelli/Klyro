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

  it('returns unknown for /model with no argument', () => {
    expect(parse('/model')).toEqual({ kind: 'unknown', raw: '/model' });
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
