import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Import patterns that must never be reachable from deterministic code. Generated agents and
 * Temporal workflow code both run inside the workflow sandbox, so neither may pull in a provider
 * SDK, a database client, or Node built-ins that perform I/O.
 */
const FORBIDDEN_IN_DETERMINISTIC_CODE = [
  '@supabase/*',
  'openai',
  '@composio/*',
  'playwright',
  'pdf-parse',
  'tesseract.js',
  'node:fs',
  'fs',
  'node:child_process',
  'child_process',
  'node:https',
  'p-limit',
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.meridian/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/next-env.d.ts',
      'supabase/.temp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // meridian/no-forbidden-imports-in-generated-agents
    files: ['generated-agents/**/*.ts'],
    ignores: ['generated-agents/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // The package root is named as an exact path rather than as a pattern. Patterns are
          // matched with gitignore semantics, under which `@meridian/agent-kit` also covers
          // everything beneath it and — by the same gitignore rule that forbids re-including a file
          // inside an excluded directory — `!@meridian/agent-kit/contracts` cannot bring the one
          // permitted subpath back. Splitting the two forms says exactly what is meant: the root is
          // banned, subpaths other than `contracts` are banned, `contracts` is the way in.
          paths: [
            {
              name: '@meridian/agent-kit',
              message:
                'Generated agents may import @meridian/agent-kit/contracts only, never the runtime entry point.',
            },
          ],
          patterns: [
            ...FORBIDDEN_IN_DETERMINISTIC_CODE.map((group) => ({
              group: [group],
              message:
                'Generated agents are thin and deterministic: import only @meridian/agent-kit/contracts and @meridian/core/schemas.',
            })),
            {
              group: ['@meridian/agent-kit/*', '!@meridian/agent-kit/contracts'],
              message:
                'Generated agents may import @meridian/agent-kit/contracts only, never the runtime entry point.',
            },
          ],
        },
      ],
    },
  },
  {
    // meridian/no-nondeterministic-in-workflow
    files: ['apps/backend/src/temporal/workflows/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...FORBIDDEN_IN_DETERMINISTIC_CODE.map((group) => ({
              group: [group],
              message: 'Workflow code is deterministic: move this into an activity.',
            })),
            {
              group: ['@temporalio/activity'],
              message: '@temporalio/activity may not be imported from workflow code.',
            },
            {
              group: ['node:crypto', 'crypto'],
              message: 'Workflow code may not use crypto directly; derive values in an activity.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Use AgentContext.clock / workflow.now() inside workflow code.' },
        { name: 'process', message: 'Workflow code may not read process state.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Workflow code must be deterministic.' },
        {
          object: 'Date',
          property: 'now',
          message: 'Read the clock through AgentContext.clock, which the sandbox drives.',
        },
      ],
    },
  },
  {
    files: ['**/test/**/*.ts', '**/test/**/*.tsx', '**/e2e/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    files: ['apps/web/**/*.tsx', 'apps/web/**/*.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // Written by `supabase gen types`, regenerated by `pnpm db:types`, and never edited by hand.
    // Its conditional types end in `: never` branches that the rule reads as redundant; silencing
    // the rule here is the only way to keep the file byte-identical to what the generator emits.
    files: ['packages/core/src/database.types.ts'],
    rules: { '@typescript-eslint/no-redundant-type-constituents': 'off' },
  },
);
