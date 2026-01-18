import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_?' }],
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      // Relaxed: These rules are too strict for practical use
      '@typescript-eslint/strict-boolean-expressions': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', {
        allowNumber: true,
        allowBoolean: true,
        allowNullish: true,  // Allow undefined in templates (common pattern)
      }],
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',  // Warn instead of error
      '@typescript-eslint/no-deprecated': 'warn',  // Warn about deprecated APIs
      '@typescript-eslint/require-await': 'off',  // Allow async without await (interface implementation)
      '@typescript-eslint/no-unsafe-assignment': 'off',  // Allow dynamic imports
      '@typescript-eslint/no-unsafe-member-access': 'off',  // Allow dynamic imports
      '@typescript-eslint/no-unsafe-return': 'off',  // Allow logger return
      '@typescript-eslint/no-empty-object-type': 'off',  // Allow empty interfaces for extensibility
      '@typescript-eslint/no-redundant-type-constituents': 'off',  // Allow unknown in unions
      '@typescript-eslint/no-unnecessary-condition': 'off',  // Allow defensive checks
    },
  },
  {
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
      '*.config.js',
      '*.config.ts',
      'ui/',
      'tests/',  // Exclude tests from linting (not in tsconfig.json)
    ],
  }
);
