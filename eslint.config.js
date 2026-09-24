import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-screenshot/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.vite/**',
      '**/.claude/**',
      '**/.foreman/**',
      'apps/web/src/routeTree.gen.ts',
      'packages/pve-api/schema/**',
      'packages/pve-api/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // TanStack Router route files must export `Route` alongside their component.
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true, allowExportNames: ['Route'] },
      ],
    },
  },
  {
    // shadcn/ui primitives export variant helpers (cva) next to components by design, and
    // TanStack Router route files export `Route` objects rather than components. Fast refresh
    // still works for both; the heuristic just cannot tell.
    files: ['apps/web/src/components/ui/**/*.{ts,tsx}', 'apps/web/src/routes/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
