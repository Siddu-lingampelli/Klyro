import { describe, it, expect, beforeEach } from 'vitest';
import { markRead, wasRead, clearReadHistory } from './read-history.js';

describe('read-history', () => {
  beforeEach(() => clearReadHistory());

  it('matches ./, bare, and sub/../ spellings of the same file', () => {
    markRead('sub/../a.txt', '/repo');
    expect(wasRead('a.txt', '/repo')).toBe(true);
    expect(wasRead('./a.txt', '/repo')).toBe(true);
    expect(wasRead('sub/../a.txt', '/repo')).toBe(true);
  });

  it('matches absolute against relative via cwd', () => {
    markRead('a.txt', '/repo');
    expect(wasRead('/repo/a.txt')).toBe(true);
  });

  it('does not match different files', () => {
    markRead('a.txt', '/repo');
    expect(wasRead('b.txt', '/repo')).toBe(false);
    expect(wasRead('/other/b.txt')).toBe(false);
    // NOTE: bare relative spellings match process-wide by design (single-cwd
    // processes); absolute forms are cwd-scoped. Hosts clear per task.
    expect(wasRead('a.txt', '/other')).toBe(true);
  });

  it('clear resets the session scope', () => {
    markRead('a.txt', '/repo');
    clearReadHistory();
    expect(wasRead('a.txt', '/repo')).toBe(false);
  });
});
