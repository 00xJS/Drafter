#!/usr/bin/env node
// The React Compiler's health: which of src/'s components and hooks it leaves
// as written, held against a committed list (scripts/compiler-baseline.json).
//
// vite.config.ts compiles src/ with babel-plugin-react-compiler, which
// memoises every component and hook it can prove safe and leaves the rest
// alone, silently: a build that compiles one component fewer builds all the
// same, and nothing but a slower screen says so. An eslint-disable of the
// hooks rules is enough to turn a whole screen back to hand-written React.
// This runs the same plugin over the same files with a logger, and fails
// when something the list does not name is left uncompiled. Something on the
// list that compiles now is only reported: take it off with --update, so the
// list only ever shrinks.
//
//   node scripts/compiler-check.mjs            check (npm run check runs it)
//   node scripts/compiler-check.mjs --update   write the list as it stands now
//
// A function is named by its file and its name, not its line, so an edit
// elsewhere in the file does not move it; the reason is kept beside it for
// whoever reads the list. The plugin runs as Vite runs it, with no options.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync, transformSync, traverse } from '@babel/core'
import reactCompiler from 'babel-plugin-react-compiler'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const BASELINE = join(ROOT, 'scripts/compiler-baseline.json')

/** The files Vite compiles: src/ as the app ships it, never its tests or declarations. */
export function sourceFiles(dir = SRC) {
  /** @type {string[]} */
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out.sort()
}

/** @type {import('@babel/core').ParserOptions} as Vite's React plugin parses src/: TypeScript with JSX */
const PARSER = { plugins: ['jsx', 'typescript'] }

/**
 * Every function's name by where it starts ("line:column"): its own name, or
 * the variable, property or default export it is assigned to. The compiler
 * names the functions it compiles; one it gives up on comes with a place only.
 * @param {string} code
 * @param {string} filename
 */
function functionNames(code, filename) {
  /** @type {Map<string, string>} */
  const names = new Map()
  const ast = parseSync(code, { filename, babelrc: false, configFile: false, parserOpts: PARSER })
  if (!ast) return names
  traverse(ast, {
    Function(path) {
      const node = path.node
      const start = node.loc?.start
      if (!start) return
      const parent = path.parent
      let name = 'id' in node && node.id ? node.id.name : null
      if (!name && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') name = parent.id.name
      // memo(function…), forwardRef(() => …): the call's variable
      if (!name && parent.type === 'CallExpression' && path.parentPath.parent.type === 'VariableDeclarator') {
        const declarator = path.parentPath.parent
        if (declarator.id.type === 'Identifier') name = declarator.id.name
      }
      if (!name && (parent.type === 'ObjectProperty' || parent.type === 'ClassProperty') && parent.key.type === 'Identifier') name = parent.key.name
      if (!name && parent.type === 'ExportDefaultDeclaration') name = 'default'
      names.set(`${start.line}:${start.column}`, name ?? '<anonymous>')
    },
  })
  return names
}

/** The first line of why the compiler gave up, as it words it. */
function reasonOf(event) {
  if (event.kind === 'CompileSkip') return `skipped: ${event.reason}`
  if (event.kind === 'PipelineError') return `pipeline error: ${String(event.data).split('\n')[0]}`
  const detail = event.detail ?? {}
  const text = detail.reason ?? detail.options?.reason ?? detail.description ?? String(detail)
  return String(text).split('\n')[0]
}

/**
 * What the compiler made of each file: the functions it compiled, and the
 * ones it left as written with why, keyed "file › name".
 * @param {string[]} files
 */
export function compileAll(files) {
  let compiled = 0
  /** @type {Map<string, string>} */
  const uncompiled = new Map()
  /** @type {string[]} */
  const broken = []
  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/')
    const code = readFileSync(file, 'utf8')
    /** @type {any[]} */
    const events = []
    try {
      transformSync(code, {
        filename: file,
        babelrc: false,
        configFile: false,
        parserOpts: PARSER,
        plugins: [[reactCompiler, { logger: { logEvent: (_file, event) => events.push(event) } }]],
        code: false,
        ast: false,
      })
    } catch (e) {
      broken.push(`${rel}: ${String(/** @type {Error} */ (e).message ?? e).split('\n')[0]}`)
      continue
    }
    const failed = events.filter(e => e.kind === 'CompileError' || e.kind === 'CompileSkip' || e.kind === 'PipelineError')
    compiled += events.filter(e => e.kind === 'CompileSuccess').length
    if (!failed.length) continue
    const names = functionNames(code, file)
    /** @type {Map<string, number>} */
    const seen = new Map()
    // one entry per function: a function the compiler refuses for three reasons is left uncompiled once
    const places = new Set()
    for (const event of failed) {
      const start = event.fnLoc?.start
      const place = start ? `${start.line}:${start.column}` : '?'
      if (places.has(place)) continue
      places.add(place)
      const name = names.get(place) ?? '<anonymous>'
      const n = (seen.get(name) ?? 0) + 1
      seen.set(name, n)
      uncompiled.set(`${rel} › ${n === 1 ? name : `${name} #${n}`}`, reasonOf(event))
    }
  }
  return { compiled, uncompiled, broken }
}

/** @returns {Record<string, string>} */
function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8')).uncompiled ?? {}
  } catch {
    return {}
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const started = Date.now()
  const { compiled, uncompiled, broken } = compileAll(sourceFiles())
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (broken.length) {
    console.error(`compiler-check: Babel could not read ${broken.length} file(s):\n  ${broken.join('\n  ')}`)
    process.exit(1)
  }
  if (process.argv.includes('--update')) {
    const sorted = Object.fromEntries([...uncompiled].sort(([a], [b]) => a.localeCompare(b)))
    const about = 'Components and hooks the React Compiler leaves as written, and why. scripts/compiler-check.mjs fails on one not listed here; take one off (--update) once it compiles.'
    writeFileSync(BASELINE, `${JSON.stringify({ about, uncompiled: sorted }, null, 2)}\n`)
    console.log(`compiler-check: wrote scripts/compiler-baseline.json: ${uncompiled.size} left as written, ${compiled} compiled (${seconds} s)`)
    process.exit(0)
  }
  const baseline = readBaseline()
  const regressed = [...uncompiled].filter(([key]) => !Object.hasOwn(baseline, key))
  const fixed = Object.keys(baseline).filter(key => !uncompiled.has(key))
  if (regressed.length) {
    console.error(
      `compiler-check: the React Compiler now leaves ${regressed.length} more as written, so they re-render as hand-written React:\n` +
        regressed.map(([key, why]) => `  ${key}\n    ${why}`).join('\n') +
        '\nFix what it names (an eslint-disable of the hooks rules is the usual cause), or, if it has to stay, add it with: node scripts/compiler-check.mjs --update',
    )
    process.exit(1)
  }
  console.log(`compiler-check: ${compiled} components and hooks compiled; ${uncompiled.size} left as written, each in the baseline (${seconds} s)`)
  if (fixed.length) {
    console.log(`compiler-check: ${fixed.length} in the baseline compile now; take them off with --update:\n  ${fixed.join('\n  ')}`)
  }
}
