import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { DiffView, type DiffHunk } from './diff.js';
import { parseUnifiedDiff } from './diff-parser.js';

const SAMPLE = `diff --git a/src/foo.ts b/src/foo.ts
index 1234..5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export {};
diff --git a/src/bar.ts b/src/bar.ts
index aaaa..bbbb 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,2 +1,2 @@
-const x = 'old';
+const x = 'new';
`;

describe('parseUnifiedDiff', () => {
  it('returns one hunk per file', () => {
    const hunks = parseUnifiedDiff(SAMPLE);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.path).toBe('src/foo.ts');
    expect(hunks[1]!.path).toBe('src/bar.ts');
  });

  it('classifies add/remove/context/header lines', () => {
    const hunks = parseUnifiedDiff(SAMPLE);
    const lines = hunks[0]!.lines;
    expect(lines[0]!.kind).toBe('header');
    expect(lines[1]!.kind).toBe('context');
    expect(lines[2]!.kind).toBe('remove');
    expect(lines[3]!.kind).toBe('add');
    expect(lines[4]!.kind).toBe('add');
  });

  it('skips index/binary/no-newline markers', () => {
    const hunks = parseUnifiedDiff(SAMPLE);
    for (const h of hunks) {
      for (const l of h.lines) {
        expect(l.text).not.toMatch(/^index /);
        expect(l.text).not.toMatch(/Binary files/);
        expect(l.text).not.toMatch(/No newline at end/);
      }
    }
  });

  it('returns empty array for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

describe('DiffView', () => {
  it('shows an empty-state when hunks is empty', () => {
    const { lastFrame } = render(<DiffView hunks={[]} />);
    expect(lastFrame()).toContain('no working-tree changes');
  });

  it('renders a file header and line glyphs', () => {
    const hunks: DiffHunk[] = [
      {
        path: 'src/foo.ts',
        lines: [
          { kind: 'header', text: '@@ -1 +1 @@' },
          { kind: 'context', text: 'const a = 1;' },
          { kind: 'remove', text: 'const b = 2;' },
          { kind: 'add', text: 'const b = 3;' },
        ],
      },
    ];
    const { lastFrame } = render(<DiffView hunks={hunks} summary="1 file changed" />);
    const out = lastFrame();
    expect(out).toContain('src/foo.ts');
    expect(out).toContain('+ const b = 3;');
    expect(out).toContain('- const b = 2;');
    expect(out).toContain('1 file changed');
  });

  it('truncates long lines', () => {
    const long = 'x'.repeat(500);
    const hunks: DiffHunk[] = [
      { path: 'f.ts', lines: [{ kind: 'add', text: long }] },
    ];
    const { lastFrame } = render(<DiffView hunks={hunks} />);
    expect(lastFrame()).toContain('…');
  });
});
