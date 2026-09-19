import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig(
  {
    ignores: ['out/**', 'dist/**', 'release/**', 'coverage/**', 'node_modules/**', '.internal/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // All OS-specific behaviour lives in src/main/platform so that adding Windows/Linux
    // support means editing one place. Everything else asks that layer instead.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/main/platform/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='platform']",
          message:
            'Do not read process.platform directly. Use toPlatformId() and the helpers in src/main/platform.',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
)
