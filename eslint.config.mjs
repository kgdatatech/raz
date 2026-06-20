// @ts-check
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

/** @type {import('eslint').Linter.Config[]} */
const config = [
  // Global ignores
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'dist/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
    ],
  },
  // TypeScript source files
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Enforce typed code — mirrors tsconfig strict
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      // No console.log in production code
      'no-console': 'error',
    },
  },
]

export default config
