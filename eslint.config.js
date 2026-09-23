import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

// What src is held to. The server code — Netlify functions, the MCP server,
// the rules shared with the app, and the scripts — is held to the same, and
// so are the build's own config files.
const rules = {
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  '@typescript-eslint/no-explicit-any': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
}

/**
 * Where `any` stays allowed: the hand-written declarations of the server's
 * JavaScript, whose records are loose by design (mcp/data.d.mts `Item`), and
 * the tests, whose stand-ins for Deno, fetch or a client are typed only as far
 * as the test needs. Everything the app and the server run is typed.
 */
const looseAny = { '@typescript-eslint/no-explicit-any': 'off' }

const server = ['netlify/functions', 'mcp', 'shared', 'scripts']

/**
 * No reading the clock as a view renders: `new Date()`, `Date.now()`, and
 * `localDayKey()` or `startOfDay()` with nothing handed in. The React Compiler
 * caches a value worked out from nothing that changes for as long as the view
 * is mounted, and Home stays mounted for days on the phone: its heading kept
 * the day the app was opened, and so did every "Today" badge. The time comes
 * from useNow() or useDayKey() instead. A reading inside a handler, an effect
 * or a useState initialiser runs when that does, and is left alone; one in a
 * useMemo, an array method's callback or a function called on the spot runs
 * as the view renders, and is not.
 */
const SYNC_CALLBACKS = new Set(['map', 'filter', 'find', 'findIndex', 'findLast', 'some', 'every', 'reduce', 'flatMap', 'forEach', 'sort', 'toSorted'])
const isFunction = n => n?.type === 'FunctionDeclaration' || n?.type === 'FunctionExpression' || n?.type === 'ArrowFunctionExpression'
const functionName = fn => {
  if (fn.id?.name) return fn.id.name
  const p = fn.parent
  if (p?.type === 'VariableDeclarator' && p.id.type === 'Identifier') return p.id.name
  if (p?.type === 'CallExpression' && p.parent?.type === 'VariableDeclarator' && p.parent.id.type === 'Identifier') return p.parent.id.name
  return null
}
const noRenderClock = {
  meta: {
    type: 'problem',
    messages: { clock: '{{what}} as {{where}} renders: the React Compiler keeps the first answer for as long as the view is mounted. Take the time from useNow() or useDayKey().' },
  },
  create(context) {
    const check = (node, what) => {
      let fn = null
      for (let n = node; n.parent; n = n.parent) {
        // a default for a prop the caller leaves out: the compiler will not cache a component that has one
        if (isFunction(n.parent) && n.parent.params.includes(n)) return
        if (!isFunction(n.parent)) continue
        const f = n.parent
        const call = f.parent?.type === 'CallExpression' ? f.parent : null
        // called on the spot, or an array method's callback: it runs as the view renders
        if (call && (call.callee === f || (call.arguments.includes(f) && call.callee.type === 'MemberExpression' && SYNC_CALLBACKS.has(call.callee.property?.name)))) continue
        fn = f
        break
      }
      if (!fn) return
      const call = fn.parent?.type === 'CallExpression' ? fn.parent : null
      if (call?.callee.type === 'Identifier' && call.callee.name === 'useMemo' && call.arguments[0] === fn) {
        return context.report({ node, messageId: 'clock', data: { what, where: 'a memo' } })
      }
      const name = functionName(fn)
      if (name && /^([A-Z]|use[A-Z])/.test(name)) context.report({ node, messageId: 'clock', data: { what, where: name } })
    }
    return {
      'NewExpression[callee.name="Date"][arguments.length=0]': node => check(node, 'new Date()'),
      'CallExpression[callee.object.name="Date"][callee.property.name="now"]': node => check(node, 'Date.now()'),
      'CallExpression[callee.name=/^(localDayKey|startOfDay)$/][arguments.length=0]': node => check(node, `${node.callee.name}()`),
    }
  },
}

export default tseslint.config(
  // supabase/functions/bot is Deno: its own globals and jsr: imports, so
  // Deno lints and type-checks it (the bot job in .github/workflows/ci.yml).
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
    files: ['src/__tests__/**/*.{ts,tsx}'],
    rules: looseAny,
  },
  {
    // Home and the cards it draws, the due badge every task list draws, and
    // Bills, Finance and Stats: views a phone is left open on overnight, and
    // resumed on days later. Other views still read the clock as they
    // render, and join this list as they are moved onto the hooks.
    files: [
      'src/components/Today.tsx',
      'src/components/BriefingCard.tsx',
      'src/components/HabitsCard.tsx',
      'src/components/RoutinesCard.tsx',
      'src/components/JournalCard.tsx',
      'src/components/MealIdeasCard.tsx',
      'src/components/wardrobe/WardrobeCard.tsx',
      'src/components/bits.tsx',
      'src/components/Bills.tsx',
      'src/components/Finance.tsx',
      'src/components/planner/StatsScreen.tsx',
      'src/components/People.tsx',
      'src/components/Places.tsx',
      'src/components/StatsLens.tsx',
      'src/components/PlacesStats.tsx',
      'src/components/kitchen/KitchenStats.tsx',
      'src/components/RichNotes.tsx',
    ],
    plugins: { drafter: { rules: { 'no-render-clock': noRenderClock } } },
    rules: { 'drafter/no-render-clock': 'error' },
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
    rules: { ...rules, ...looseAny },
  },
  {
    // The build's own configuration, run by Node through Vite, the Capacitor
    // CLI and Playwright (tsconfig.config.json and e2e/tsconfig.json type-check them).
    files: ['vite.config.ts', 'capacitor.config.ts', 'playwright.config.ts'],
    languageOptions: { globals: globals.node },
    rules,
  },
  {
    // The rules shared with the app, in TypeScript (tsconfig.shared.json):
    // typed properly, so nothing in them is `any`.
    files: ['shared/**/*.mts'],
    rules,
  },
)
