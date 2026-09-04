import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Header, abbrevPath } from './header.js';

describe('abbrevPath', () => {
  it('passes through short paths unchanged', () => {
    expect(abbrevPath('/tmp/x')).toBe('/tmp/x');
    expect(abbrevPath('C:\\projects\\app')).toBe('C:\\projects\\app');
  });

  it('keeps the last two segments of long paths', () => {
    // 7 segments → last two are "src" and "index.ts".
    expect(abbrevPath('/home/user/projects/some-really-deeply-nested-name/my-app/src/index.ts'))
      .toBe('…/src/index.ts');
  });

  it('handles windows-style backslashes in long paths', () => {
    const longWin = 'C:\\Users\\L.Siddhartha\\projects\\some-really-deep-name\\klyro-thing\\src\\index.ts';
    expect(abbrevPath(longWin)).toBe('…\\src\\index.ts');
  });
});

describe('Header', () => {
  it('shows the app name, cwd, model, and step counter', () => {
    const { lastFrame } = render(
      <Header cwd="/tmp/proj" model="claude-sonnet" step={3} maxSteps={30} />,
    );
    const out = lastFrame();
    expect(out).toContain('KLYRO');
    expect(out).toContain('/tmp/proj');
    expect(out).toContain('claude-sonnet');
    expect(out).toMatch(/step 3\/30/);
  });

  it('highlights the step counter when at or above maxSteps', () => {
    const { lastFrame } = render(
      <Header cwd="/p" model="m" step={30} maxSteps={30} />,
    );
    const out = lastFrame();
    expect(out).toMatch(/step 30\/30/);
  });
});
