/**
 * scroll.md §15.1 — mouse splitter unit tests (no terminal).
 */
import { describe, it, expect } from 'vitest';
import { MouseFilter, WHEEL_LINES, PasteFilter, createReadWrapper, isMouseReportingEnabled } from './mouse.js';

describe('isMouseReportingEnabled', () => {
  it('defaults OFF so native select-to-copy and right-click paste work', () => {
    expect(isMouseReportingEnabled({})).toBe(false);
    expect(isMouseReportingEnabled({ KLYRO_MOUSE: '0' })).toBe(false);
    expect(isMouseReportingEnabled({ KLYRO_MOUSE: '' })).toBe(false);
  });
  it('opts in with KLYRO_MOUSE=1 for wheel scrolling', () => {
    expect(isMouseReportingEnabled({ KLYRO_MOUSE: '1' })).toBe(true);
  });
});

describe('MouseFilter', () => {
  it('passes normal typing through untouched', () => {
    const f = new MouseFilter();
    const r = f.push(Buffer.from('hello /clear\r', 'utf-8'));
    expect(r.kept.toString('utf-8')).toBe('hello /clear\r');
    expect(r.wheels).toEqual([]);
  });
  it('passes arrow/page keys through (Ink still handles keyboard)', () => {
    const f = new MouseFilter();
    const r = f.push(Buffer.from('\x1b[A\x1b[5~\x1b[H', 'latin1'));
    expect(r.kept.toString('latin1')).toBe('\x1b[A\x1b[5~\x1b[H');
    expect(r.wheels).toEqual([]);
  });
  it('swallows SGR wheel-up as -3 lines, wheel-down as +3', () => {
    const f = new MouseFilter();
    const up = f.push(Buffer.from('\x1b[<64;10;20M', 'latin1'));
    expect(up.kept.length).toBe(0);
    expect(up.wheels).toEqual([-WHEEL_LINES]);
    const down = f.push(Buffer.from('\x1b[<65;10;20m', 'latin1'));
    expect(down.kept.length).toBe(0);
    expect(down.wheels).toEqual([WHEEL_LINES]);
  });
  it('swallows clicks/motion without emitting deltas', () => {
    const f = new MouseFilter();
    const r = f.push(Buffer.from('\x1b[<0;10;20M\x1b[<32;11;21M', 'latin1'));
    expect(r.kept.length).toBe(0);
    expect(r.wheels).toEqual([]);
  });
  it('handles X10 fallback encoding', () => {
    const f = new MouseFilter();
    // Cb=64+32='`' (96), down=65+32='a' (97); Cx/Cy arbitrary +32
    const r = f.push(Buffer.from([0x1b, 0x5b, 0x4d, 96, 50, 50, 0x1b, 0x5b, 0x4d, 97, 50, 50]));
    expect(r.kept.length).toBe(0);
    expect(r.wheels).toEqual([-WHEEL_LINES, WHEEL_LINES]);
  });
  it('handles a sequence split across chunks', () => {
    const f = new MouseFilter();
    const a = f.push(Buffer.from('\x1b[<6', 'latin1'));
    expect(a.kept.length).toBe(0);
    expect(a.wheels).toEqual([]);
    const b = f.push(Buffer.from('4;10;20Mrest', 'latin1'));
    expect(b.kept.toString('latin1')).toBe('rest');
    expect(b.wheels).toEqual([-WHEEL_LINES]);
  });
  it('lone trailing ESC passes through immediately (Esc must not lag)', () => {
    const f = new MouseFilter();
    const r = f.push(Buffer.from('\x1b', 'latin1'));
    expect(r.kept.toString('latin1')).toBe('\x1b');
  });
  it('mixed typing + wheel in one chunk', () => {
    const f = new MouseFilter();
    const r = f.push(Buffer.from('ab\x1b[<65;1;1Mcd', 'latin1'));
    expect(r.kept.toString('latin1')).toBe('abcd');
    expect(r.wheels).toEqual([WHEEL_LINES]);
  });
});

describe('createReadWrapper (Ink paused-mode tap)', () => {
  it('swallows wheel chunks (returns null) and dispatches deltas', () => {
    const seen: number[] = [];
    const chunks: Array<Buffer | null> = [Buffer.from('\x1b[<64;5;5M', 'latin1'), null];
    const read = createReadWrapper(() => chunks.shift() ?? null, new MouseFilter(), (d) => seen.push(d));
    expect(read()).toBeNull();
    expect(seen).toEqual([-WHEEL_LINES]);
    expect(read()).toBeNull();
  });
  it('passes typing through byte-identical, preserving string shape', () => {
    const seen: number[] = [];
    const chunks: Array<string | null> = ['hello', null];
    const read = createReadWrapper(() => chunks.shift() ?? null, new MouseFilter(), (d) => seen.push(d));
    expect(read()).toBe('hello');
    expect(seen).toEqual([]);
    expect(read()).toBeNull();
  });
  it('splits mixed chunks: wheels dispatched, text returned', () => {
    const seen: number[] = [];
    const chunks: Array<Buffer | null> = [Buffer.from('ab\x1b[<65;1;1Mcd', 'latin1'), null];
    const read = createReadWrapper(() => chunks.shift() ?? null, new MouseFilter(), (d) => seen.push(d));
    const out = read() as Buffer;
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.toString('latin1')).toBe('abcd');
    expect(seen).toEqual([WHEEL_LINES]);
  });
  it('passes sized reads through untouched', () => {
    const seen: number[] = [];
    const marker = Buffer.from('x');
    const read = createReadWrapper(() => marker, new MouseFilter(), (d) => seen.push(d));
    expect(read(5)).toBe(marker);
    expect(seen).toEqual([]);
  });
});

describe('PasteFilter (bracketed paste)', () => {
  const B = (s: string) => Buffer.from(s, 'latin1');
  it('strips markers and delivers one atomic paste', () => {
    const f = new PasteFilter();
    const r = f.push(B('hi \x1b[200~pasted\ntext\x1b[201~ bye'));
    expect(r.kept.toString('latin1')).toBe('hi  bye');
    expect(r.pastes).toEqual(['pasted\ntext']);
  });
  it('reassembles a paste split across chunks', () => {
    const f = new PasteFilter();
    const r1 = f.push(B('\x1b[200~par'));
    expect(r1.pastes).toEqual([]);
    const r2 = f.push(B('tial\x1b[20'));
    expect(r2.pastes).toEqual([]);
    const r3 = f.push(B('1~'));
    expect(r3.pastes).toEqual(['partial']);
  });
  it('holds an unterminated paste (no leak into input)', () => {
    const f = new PasteFilter();
    const r = f.push(B('\x1b[200~secret-in-progress'));
    expect(r.kept.length).toBe(0);
    expect(r.pastes).toEqual([]);
  });
  it('passes plain typing through byte-identical', () => {
    const f = new PasteFilter();
    const r = f.push(B('hello world'));
    expect(r.kept.toString('latin1')).toBe('hello world');
    expect(r.pastes).toEqual([]);
  });
});
