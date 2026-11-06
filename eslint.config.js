// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'kit/',
      'plugins/',
      'test/fixtures/',
      'build/',
      'coverage/',
      'node_modules/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // stdout is the MCP protocol channel: the server may only log to stderr.
    files: ['src/**/*.ts'],
    rules: {
      'no-console': ['error', { allow: ['error'] }],
    },
  },
);
