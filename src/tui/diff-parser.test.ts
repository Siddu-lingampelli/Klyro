import { describe, it, expect } from 'vitest';
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

  it('keeps the real path for a deleted file (+++ /dev/null)', () => {
    const hunks = parseUnifiedDiff(
      'diff --git a/src/gone.ts b/src/gone.ts\n--- a/src/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n',
    );
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.path).toBe('src/gone.ts');
  });

  it('flushes the previous file when a new +++ arrives without a diff header', () => {
    const hunks = parseUnifiedDiff(
      '+++ b/src/a.ts\n@@ -1 +1 @@\n-old-a\n+new-a\n+++ b/src/b.ts\n@@ -1 +1 @@\n-old-b\n+new-b\n',
    );
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.path).toBe('src/a.ts');
    expect(hunks[0]!.lines.map((l) => l.text)).toContain('new-a');
    expect(hunks[1]!.path).toBe('src/b.ts');
    expect(hunks[1]!.lines.map((l) => l.text)).toContain('new-b');
  });
});
