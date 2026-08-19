import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': ['warn', { allow: ['error'] }],
    },
  },
  {
    // The dependency rule, enforced by the linter rather than by convention:
    // domain layers may not import infrastructure, frameworks or drivers.
    files: ['src/modules/*/domain/**/*.ts', 'src/shared/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pg', 'express', '**/repositories/*', '**/infrastructure/*'],
              message: 'Domain layer must not depend on infrastructure.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
