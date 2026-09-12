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
console.log(`check-precache: all ${assets.length} files in dist/assets are precached by dist/sw.js`)
