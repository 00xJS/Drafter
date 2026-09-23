import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

// What src is held to. The server code — Netlify functions, the MCP server,
// the rules shared with the app, and the scripts — is held to the same.
const rules = {
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  '@typescript-eslint/no-explicit-any': 'off',
  'no-empty': ['error', { allowEmptyCatch: true }],
}

const server = ['netlify/functions', 'mcp', 'shared', 'scripts']

export default tseslint.config(
  // supabase/functions/bot is Deno: its own globals and URL imports.
  // e2e/.dist and the two report folders are what `npm run e2e` builds and writes.
  { ignores: ['dist/**', 'ios/**', 'node_modules/**', 'supabase/functions/**', 'e2e/.dist/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The rules of hooks, and the React Compiler's own checks (vite.config.ts
    // compiles src/ with it): a component it cannot prove safe is left
    // uncompiled, so what these report is either a bug or lost memoisation.
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs['recommended-latest'].rules, ...rules },
  },
  {
    // Plain ES modules run by Node (functions on Netlify, the MCP server over
    // stdio, the smoke scripts), so Node's globals, fetch and Response included.
    files: server.map(dir => `${dir}/**/*.mjs`),
    languageOptions: { globals: globals.node },
    rules,
  },
  {
    // The hand-written declarations beside those modules.
    files: server.map(dir => `${dir}/**/*.d.mts`),
    rules,
  },
  {
    // The rules shared with the app, in TypeScript (tsconfig.shared.json):
    // typed properly, so nothing in them is `any`.
    files: ['shared/**/*.mts'],
    rules: { ...rules, '@typescript-eslint/no-explicit-any': 'error' },
  },
)
