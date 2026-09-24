/**
 * scroll.md §5 — binding-table unit tests (pure, no terminal).
 */
import { describe, it, expect, vi } from 'vitest';
import { getTranscriptCommand, parseSessionNote, handleHashNoteLine } from './transcript-commands.js';

describe('getTranscriptCommand (§5 binding table)', () => {
  it('PageUp / Ctrl+U → messages_half_page_up', () => {
    expect(getTranscriptCommand('', { pageUp: true })).toBe('messages_half_page_up');
    expect(getTranscriptCommand('u', { ctrl: true })).toBe('messages_half_page_up');
  });
  it('PageDown / Ctrl+D → messages_half_page_down', () => {
    expect(getTranscriptCommand('', { pageDown: true })).toBe('messages_half_page_down');
    expect(getTranscriptCommand('d', { ctrl: true })).toBe('messages_half_page_down');
  });
  it('Ctrl+Home → first, Ctrl+End → last', () => {
    expect(getTranscriptCommand('', { home: true, ctrl: true })).toBe('messages_first');
    expect(getTranscriptCommand('', { end: true, ctrl: true })).toBe('messages_last');
  });
  it('plain Home/End are NOT transcript commands (App binds them separately)', () => {
    expect(getTranscriptCommand('', { home: true })).toBeUndefined();
    expect(getTranscriptCommand('', { end: true })).toBeUndefined();
  });
  it('typing and other keys → undefined', () => {
    expect(getTranscriptCommand('a', {})).toBeUndefined();
    expect(getTranscriptCommand('u', {})).toBeUndefined();
    expect(getTranscriptCommand('', { ctrl: true })).toBeUndefined();
    expect(getTranscriptCommand('\r', {})).toBeUndefined();
  });
});

describe('# note command (4.4c)', () => {
  it('parseSessionNote returns text for "# " lines', () => {
    expect(parseSessionNote('# remember to check tests')).toBe('remember to check tests');
    expect(parseSessionNote('#   spaced   ')).toBe('spaced');
  });
  it('parseSessionNote rejects non-notes', () => {
    expect(parseSessionNote('#nospace')).toBeUndefined();
    expect(parseSessionNote('#')).toBeUndefined();
    expect(parseSessionNote('#   ')).toBeUndefined();
    expect(parseSessionNote('regular prompt')).toBeUndefined();
    expect(parseSessionNote('/status')).toBeUndefined();
  });
  it('handleHashNoteLine appends the note and persists it', () => {
    const append = vi.fn();
    const persist = vi.fn();
    expect(handleHashNoteLine('# ship it', append, persist)).toBe(true);
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]![0]).toContain('ship it');
    expect(persist).toHaveBeenCalledWith('ship it');
  });
  it('handleHashNoteLine returns false without appending for prompts', () => {
    const append = vi.fn();
    expect(handleHashNoteLine('just a prompt', append)).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });
});
