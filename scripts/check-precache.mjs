// Every file `vite build` writes to dist/assets must be in the service
// worker's precache list (dist/sw.js), or an offline launch breaks on the
// first lazy view or editor whose chunk was left out. Run after vite build.
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

const sw = readFileSync(swPath, 'utf8')
const files = dir => readdirSync(dir).flatMap(name => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]))
const assets = files(assetsDir).map(file => relative(dist, file).split(sep).join('/'))
const missing = assets.filter(url => !sw.includes(`"${url}"`) && !sw.includes(`'${url}'`))

if (missing.length) {
  console.error(`check-precache: ${missing.length} of ${assets.length} files in dist/assets are not precached by dist/sw.js:\n  ${missing.join('\n  ')}`)
  process.exit(1)
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
// client out and reads about 200 KiB lighter.
const PRECACHE_BUDGET_KIB = 2048
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
console.log(`check-precache: all ${assets.length} files in dist/assets are precached by dist/sw.js`)
