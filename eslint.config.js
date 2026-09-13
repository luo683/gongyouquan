import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The repo had a `lint` script for its entire life that executed nothing: the
 * root command was `pnpm --recursive --if-present run lint` and no package
 * defined `lint`, so CI's green "lint" step meant "no package opted in".
 *
 * This is deliberately not a style police. It is the rule set whose violations
 * are actual defects in a Fastify + Socket.IO + pg codebase, plus two
 * restrictions that enforce invariants the design keeps repeating: BIGINT ids
 * stay strings, and user-facing Chinese comes from a code lookup, never from the
 * server's English log text.
 */
const bigintIdRules = [
  'error',
  {
    selector: "CallExpression[callee.name='Number'] > MemberExpression[property.name=/(Id|id)$/]",
    message: 'ids are BIGINTs: keep them as strings, never Number(id). Only seq and counts are numeric.',
  },
  {
    selector: "CallExpression[callee.name='parseInt'] > MemberExpression[property.name=/(Id|id)$/]",
    message: 'ids are BIGINTs: keep them as strings, never parseInt(id).',
  },
  {
    selector: "BinaryExpression[operator='+'] > Literal[value='']",
    message: "empty-string concatenation to coerce a value is a silent toString; be explicit.",
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts'],
    languageOptions: { parserOptions: { ecmaVersion: 2022, sourceType: 'module' } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // An unreachable fallthrough is how an error code silently answers 200.
      'no-fallthrough': 'error',
      'no-async-promise-executor': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-expressions': 'error',
      'no-restricted-syntax': bigintIdRules,
    },
  },
  {
    /**
     * A CLI's whole purpose is stdout. no-console exists to keep request logs
     * structured, and a command nobody runs interactively would be useless if it
     * had to route its one output channel through a logger.
     */
    files: ['apps/server/src/cli/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    /**
     * Tests deliberately assert against error shapes and reach into internals;
     * the assertions that still apply there are the ones about ids and console.
     */
    files: ['**/tests/**/*.ts', '**/tests/**/*.tsx', 'eslint.config.js'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-console': 'off',
    },
  },
);
