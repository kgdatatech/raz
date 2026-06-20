import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      '**/__tests__/**/*.{ts,tsx}',
      '**/*.{spec,test}.{ts,tsx}',
    ],
    exclude: [
      'node_modules/**',
      '.next/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['lib/**/*.ts', 'app/**/*.ts', 'app/**/*.tsx'],
      exclude: [
        'node_modules/**',
        '.next/**',
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.spec.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
