import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'drizzle/**',
      '.history/**',
      'coverage/**',
      // Reference sketches and this config itself are outside the tsconfig
      // project, so the type-aware rules cannot resolve them.
      'docs/**',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Nest modules are intentionally empty classes carrying decorators.
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // Used deliberately after drizzle .returning(), which types results as
      // possibly-empty arrays even when a row is guaranteed.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `const { omitted, ...rest } = obj` is the idiomatic way to drop a key.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'after-used', ignoreRestSiblings: true, argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.spec.ts'],
    rules: {
      // Test assertions read untyped JSON response bodies constantly.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
