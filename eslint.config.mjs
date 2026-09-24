/**
 * ESLint flat config (1.1 gate: `npm run lint`).
 *
 * Pragmatic, not maximal: the codebase intentionally uses `any` at trust
 * boundaries (tool JSON, provider wire payloads) and non-null assertions
 * after explicit guards, so those rules stay off. What IS enforced:
 * no unused locals/args (dead code), prefer-const, no-var, no-eval, and
 * no-explicit-any switched OFF only because JSON-shaped data requires it —
 * new code should still prefer `unknown` + narrowing (see path-guard,
 * secret-redactor).
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'evals/results/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // scripts/*.mjs run on node globals without a package "type" context
    // the flat-config parser can see — declare them instead of undef errors.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-eval': 'error',
      // Intentionally off for this codebase: explicit escapes aid audit
      // readability, catch-and-continue is the established error policy,
      // and several assignments exist as named debug/state anchors.
      'no-useless-escape': 'off',
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
