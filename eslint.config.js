import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist', 'release', 'node_modules', 'public', 'playwright-report', 'test-results'] },

  // Engine + viewer source: type-aware linting — no-floating-promises guards
  // the codebase's `void promise` discipline, misused-promises catches the
  // async-listener class of bug.
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: {
        ...globals.browser,
        ...globals.worker,
        chrome: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // pdf-lib's dict/stream plumbing is unavoidably loosely typed; the
      // narrow `as unknown as` casts at those seams are deliberate
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      // async event listeners are an accepted idiom here (rejections already
      // funnel through applyEdit/toast); keep the rule for other positions
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      // the worker API and fakes implement async interfaces whose bodies may
      // not await; the interface, not the body, dictates the signature
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Tests (vitest, node) — type-aware but without the strictest template rules.
  {
    files: ['test/**/*.ts', 'e2e/**/*.ts', '*.config.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      // test fakes implement async interfaces without awaiting anything
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Node-side tooling that also injects code into pages (page.evaluate).

  {
    files: ['scripts/**/*.mjs', '*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node, ...globals.browser },
    },
  },

  prettier,
);
