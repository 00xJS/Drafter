// Every file `vite build` writes to dist/assets must be in the service
// worker's precache list (dist/sw.js), or an offline launch breaks on the
// first lazy view or editor whose chunk was left out — every file but the few
// chunks named below, which only work online anyway. Run after vite build.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const swPath = join(dist, 'sw.js')
const assetsDir = join(dist, 'assets')

if (!existsSync(swPath) || !existsSync(assetsDir)) {
  console.error('check-precache: dist/sw.js or dist/assets is missing — run vite build first')
  process.exit(1)
}

/**
 * Lazy chunks left out of the precache on purpose, by the name vite gives them
 * (assets/<name>-<hash>.js). Each does nothing without the network, so it is
 * fetched when first opened, into a runtime cache of its own (vite.config.ts
 * ONLINE_ONLY_CHUNKS, which must name the same ones). Below, this script makes
 * sure an offline launch still never needs one: none is loaded at launch, and
 * nothing that is precached imports one statically — only through import(),
 * which fails as that feature being offline, not as the app.
 */
const ONLINE_ONLY = [
  // Admin: the owner's panels, every one of which reads or writes through /api/admin
  'Admin',
  // the garment cut-out's web runtime: its WASM and model load from the network
  // on first use (dist/cutout/, never precached), and cutout.ts falls back without it
  'cutoutweb',
]

const sw = readFileSync(swPath, 'utf8')
const files = dir => readdirSync(dir).flatMap(name => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]))
const assets = files(assetsDir).map(file => relative(dist, file).split(sep).join('/'))
const precached = url => sw.includes(`"${url}"`) || sw.includes(`'${url}'`)
const onlineOnly = new Map(ONLINE_ONLY.map(name => [name, assets.filter(url => new RegExp(`^assets/${name}-[\\w-]+\\.js$`).test(url))]))
const online = [...onlineOnly.values()].flat()
const missing = assets.filter(url => !precached(url) && !online.includes(url))

if (missing.length) {
  console.error(`check-precache: ${missing.length} of ${assets.length} files in dist/assets are not precached by dist/sw.js:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}
for (const [name, found] of onlineOnly) {
  if (found.length !== 1) {
    console.error(`check-precache: the online-only chunk ${name} matched ${found.length} files in dist/assets, not one — rename it here and in vite.config.ts together`)
    process.exit(1)
  }
  if (precached(found[0])) {
    console.error(`check-precache: ${found[0]} is online-only here but precached by dist/sw.js — vite.config.ts ONLINE_ONLY_CHUNKS must name it too`)
    process.exit(1)
  }
}

// The build stamp the app compares itself with (src/appupdate.ts) must ship,
// and must never be precached: a cached copy would always agree with the app.
const versionPath = join(dist, 'version.json')
if (!existsSync(versionPath)) {
  console.error('check-precache: dist/version.json is missing — the app could not tell it is out of date')
  process.exit(1)
}
if (sw.includes('version.json')) {
  console.error('check-precache: dist/sw.js precaches version.json — the app would never see a newer build')
  process.exit(1)
}
const stamped = readFileSync(join(dist, 'index.html'), 'utf8').match(/<meta name="drafter-build" content="([^"]+)"/)?.[1]
const served = JSON.parse(readFileSync(versionPath, 'utf8')).build
if (!stamped || stamped !== served) {
  console.error(`check-precache: index.html's build stamp (${stamped ?? 'none'}) does not match dist/version.json (${served})`)
  process.exit(1)
}

// No assistant code at launch. vite.config.ts names every chunk that is the
// assistant's — its prompts and parsers, the retrieval Ask runs, the chat's
// actions, the recipe fill — assistant-*.js. The page loads its entry and every
// modulepreload before anything draws, and a signed-in launch adds the Planner
// chunk; none of them, and nothing any of them imports statically, may be one.
// 3d22024 meant to keep the assistant out and put it first instead: a
// manualChunks rule dragged the API and Supabase clients into the assistant's
// chunk, so the entry imported the lot and index.html modulepreloaded it.
const html = readFileSync(join(dist, 'index.html'), 'utf8')
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].slice(1).map(m => [m[1], m[2] ?? '']))
const tags = [...html.matchAll(/<(script|link)\b[^>]*>/g)].map(m => ({ name: m[1], ...attrs(m[0]) }))
const local = url => url.replace(/^\//, '')
const firstLoad = [
  ...tags.filter(t => t.name === 'script' && t.type === 'module' && t.src).map(t => local(t.src)),
  ...tags.filter(t => t.name === 'link' && t.rel === 'modulepreload' && t.href).map(t => local(t.href)),
]
const assistant = assets.filter(url => /^assets\/assistant-[\w-]+\.js$/.test(url))
if (assistant.length === 0) {
  console.error('check-precache: no assets/assistant-*.js — the chunk naming in vite.config.ts has broken, so the launch check below would pass on nothing')
  process.exit(1)
}
const preloadedAssistant = firstLoad.filter(url => assistant.includes(url))
if (preloadedAssistant.length) {
  console.error(`check-precache: index.html loads the assistant's code before first paint:\n  ${preloadedAssistant.join('\n  ')}`)
  process.exit(1)
}
const planner = assets.filter(url => /^assets\/Planner-[\w-]+\.js$/.test(url))
if (planner.length !== 1) {
  console.error(`check-precache: expected one assets/Planner-*.js, found ${planner.length} — a signed-in launch cannot be checked (has assistant code been pulled into it?)`)
  process.exit(1)
}
/** A chunk's static imports: `import … from "./x.js"` and `import "./x.js"`, never `import("./x.js")`. */
const staticImports = url => [...readFileSync(join(dist, url), 'utf8').matchAll(/\b(?:from|import)\s*["']\.\/([\w.-]+\.js)["']/g)].map(m => `assets/${m[1]}`)
const launch = new Set()
for (const todo = [...firstLoad, ...planner]; todo.length; ) {
  const url = todo.pop()
  if (launch.has(url) || !url.endsWith('.js')) continue
  launch.add(url)
  todo.push(...staticImports(url))
}
const launchedAssistant = [...launch].filter(url => assistant.includes(url))
if (launchedAssistant.length) {
  console.error(`check-precache: a launch imports the assistant's code statically:\n  ${launchedAssistant.join('\n  ')}`)
  process.exit(1)
}

// …nor any online-only chunk, and no precached file may import one statically:
// offline, that file would fail to load with it.
const launchedOnline = [...launch].filter(url => online.includes(url))
if (launchedOnline.length) {
  console.error(`check-precache: a launch loads chunks that are not precached, so an offline launch would break:\n  ${launchedOnline.join('\n  ')}`)
  process.exit(1)
}
const needsOnline = assets
  .filter(url => url.endsWith('.js') && precached(url))
  .flatMap(url => staticImports(url).filter(dep => online.includes(dep)).map(dep => `${url} imports ${dep}`))
if (needsOnline.length) {
  console.error(`check-precache: precached files import online-only chunks statically, so offline they would not load:\n  ${needsOnline.join('\n  ')}`)
  process.exit(1)
}

// The garment cut-out's model and WASM load on first use into their own cache
// (src/cutoutassets.ts). Precached, every app update would download 17.5 MB.
if (sw.includes('cutout/')) {
  console.error('check-precache: dist/sw.js precaches the garment cut-out (cutout/) — its files must load on first use only')
  process.exit(1)
}
const heavy = assets.filter(url => /\.(wasm|tflite|onnx|task)$/.test(url))
if (heavy.length) {
  console.error(`check-precache: a model or WASM file is in dist/assets, where everything is precached:\n  ${heavy.join('\n  ')}`)
  process.exit(1)
}
const cutoutDir = join(dist, 'cutout')
if (!existsSync(join(cutoutDir, 'magic-touch-v1', 'magic_touch.tflite'))) {
  console.error('check-precache: dist/cutout/magic-touch-v1/magic_touch.tflite is missing — the web cut-out would have no model')
  process.exit(1)
}
const runtimes = existsSync(cutoutDir) ? readdirSync(cutoutDir).filter(name => name.startsWith('mediapipe-')) : []
const whole = runtimes.filter(dir => ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'].every(name => existsSync(join(cutoutDir, dir, name))))
if (runtimes.length !== 1 || whole.length !== 1) {
  console.error(`check-precache: dist/cutout/ must hold exactly one mediapipe-<version>/ with vision_wasm_internal.js and .wasm, not ${runtimes.join(', ') || 'none'}`)
  process.exit(1)
}
// The precache is what every install and every app update downloads before
// the app can open offline, so it has a budget. Raise it on purpose, with the
// reason in the commit, rather than let it creep. It is there to catch models
// and images slipping in, not app code. Measure it as Netlify builds, in cloud
// mode with VITE_SUPABASE_URL set: a local-mode build leaves the Supabase
// client out and reads about 200 KiB lighter. Raised from 2048 when the React
// Compiler took on the screens it had been leaving as written: its caching is
// app code, about 90 KiB of it (37 KiB gzipped) for the first 46 of them, with
// room for the rest.
const PRECACHE_BUDGET_KIB = 2176
const entries = [...sw.matchAll(/\burl:\s*"([^"]+)"|"url":\s*"([^"]+)"/g)].map(m => m[1] ?? m[2])
const absent = entries.filter(url => !existsSync(join(dist, url)))
if (absent.length) {
  console.error(`check-precache: dist/sw.js precaches files that are not in dist, so its install would fail:\n  ${absent.join('\n  ')}`)
  process.exit(1)
}
const sizes = entries.map(url => ({ url, bytes: statSync(join(dist, url)).size })).sort((a, b) => b.bytes - a.bytes)
const kib = sizes.reduce((sum, e) => sum + e.bytes, 0) / 1024
if (kib > PRECACHE_BUDGET_KIB) {
  const largest = sizes.slice(0, 5).map(e => `${e.url} (${(e.bytes / 1024).toFixed(1)} KiB)`)
  console.error(`check-precache: the precache is ${kib.toFixed(1)} KiB, over its budget of ${PRECACHE_BUDGET_KIB} KiB; the largest files:\n  ${largest.join('\n  ')}`)
  process.exit(1)
}
console.log(`check-precache: ${entries.length} precached files, ${kib.toFixed(1)} KiB of a ${PRECACHE_BUDGET_KIB} KiB budget`)
console.log(`check-precache: ${assets.length - online.length} of ${assets.length} files in dist/assets are precached; the ${online.length} left out only work online: ${online.join(', ')}`)
console.log(`check-precache: a launch loads ${launch.size} scripts and none of the ${assistant.length} assistant chunks`)
