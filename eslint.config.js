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
  { ignores: ['dist/**', 'ios/**', 'node_modules/**', 'supabase/functions/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules, ...rules },
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
)
