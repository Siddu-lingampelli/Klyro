/**
 * scroll.md §5 — binding-table unit tests (pure, no terminal).
 */
import { describe, it, expect } from 'vitest';
import { getTranscriptCommand } from './transcript-commands.js';

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
