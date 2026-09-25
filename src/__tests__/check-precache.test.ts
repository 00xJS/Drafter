import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// scripts/check-precache.mjs, run on a build written by hand: the rules it
// holds a real build to (npm run check runs it on dist/), each shown to pass
// a build that keeps it and fail one that breaks it. These are the two the
// hash cascade's fix changed: what the page may load before anything draws,
// and that no lazy chunk imports the entry or the Planner chunk.

const SCRIPT = fileURLToPath(new URL('../../scripts/check-precache.mjs', import.meta.url))
let dist: string

afterEach(() => {
  if (dist) rmSync(dist, { recursive: true, force: true })
})

type Files = Record<string, string>

/** A build as vite writes one: the page, its chunks, the service worker's precache list, the stamp and the cut-out's runtime. */
function build(chunks: Files, { preload = ['app', 'vendor-react', 'rolldown-runtime'] }: { preload?: string[] } = {}) {
  dist = mkdtempSync(join(tmpdir(), 'drafter-precache-'))
  const assets = Object.keys(chunks).map(name => `assets/${name}`)
  const files: Files = {
    ...Object.fromEntries(Object.entries(chunks).map(([name, code]) => [`assets/${name}`, code])),
    'index.html': [
      '<!doctype html><html><head>',
      '<meta name="drafter-build" content="b1">',
      '<script type="module" crossorigin src="/assets/index-A1.js"></script>',
      ...preload.map(name => `<link rel="modulepreload" crossorigin href="/assets/${name}-A1.js">`),
      '</head><body></body></html>',
    ].join('\n'),
    'version.json': '{"build":"b1"}\n',
    // everything precached but the chunks that only work online
    'sw.js': `precacheAndRoute([${[...assets.filter(url => !/^assets\/(Admin|cutoutweb)-/.test(url)), 'index.html'].map(url => `{url:"${url}",revision:null}`).join(',')}])`,
    'cutout/magic-touch-v1/magic_touch.tflite': 'model',
    'cutout/mediapipe-1.0.1/vision_wasm_internal.js': 'runtime',
    'cutout/mediapipe-1.0.1/vision_wasm_internal.wasm': 'wasm',
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true })
    writeFileSync(join(dist, path), text)
  }
}

const check = () => {
  const run = spawnSync(process.execPath, [SCRIPT, dist], { encoding: 'utf8' })
  return { ok: run.status === 0, said: `${run.stdout}${run.stderr}` }
}

/** The chunks of a build that keeps every rule: the lazy views share the launch's code through the stable chunk. */
const KEPT: Files = {
  'index-A1.js': 'import"./app-A1.js";import"./vendor-react-A1.js";const p=()=>import("./Planner-A1.js");',
  'app-A1.js': 'import"./vendor-react-A1.js";import"./rolldown-runtime-A1.js";export const utils=1;',
  'vendor-react-A1.js': 'export const react=1;',
  'rolldown-runtime-A1.js': 'export const runtime=1;',
  'Planner-A1.js': 'import"./app-A1.js";import"./index-A1.js";const k=()=>import("./Kitchen-A1.js"),a=()=>import("./Admin-A1.js"),c=()=>import("./cutoutweb-A1.js");',
  'Kitchen-A1.js': 'import{utils}from"./app-A1.js";const f=()=>import("./assistant-A1.js");',
  'assistant-A1.js': 'import"./app-A1.js";export const ask=1;',
  'Admin-A1.js': 'import"./app-A1.js";',
  'cutoutweb-A1.js': 'import"./app-A1.js";',
}

describe('check-precache on a build', () => {
  it('passes one that keeps every rule', () => {
    build(KEPT)
    const { ok, said } = check()
    expect(said).toContain('a launch loads 5 scripts and none of the 1 assistant chunks')
    expect(ok).toBe(true)
  })

  it('lets the page load the stable chunk and the iOS bridge’s core before it draws, and nothing else', () => {
    build({ ...KEPT, 'vendor-capacitor-A1.js': 'export const core=1;' }, { preload: ['app', 'vendor-react', 'vendor-capacitor', 'rolldown-runtime'] })
    expect(check().ok).toBe(true)
    build({ ...KEPT, 'stats-A1.js': 'export const s=1;' }, { preload: ['app', 'vendor-react', 'rolldown-runtime', 'stats'] })
    const { ok, said } = check()
    expect(ok).toBe(false)
    expect(said).toContain("loads more than its entry, the stable chunk, the vendor chunks and the bundler's runtime")
    expect(said).toContain('assets/stats-A1.js')
  })

  it('fails one whose lazy chunk imports the entry: every view would be renamed with it', () => {
    build({ ...KEPT, 'Kitchen-A1.js': 'import{utils}from"./index-A1.js";' })
    const { ok, said } = check()
    expect(ok).toBe(false)
    expect(said).toContain('lazy chunks import the entry or the Planner chunk')
    expect(said).toContain('assets/Kitchen-A1.js imports assets/index-A1.js')
  })

  it('fails one whose lazy chunk imports the Planner chunk', () => {
    build({ ...KEPT, 'assistant-A1.js': 'import"./Planner-A1.js";export const ask=1;' })
    const { ok, said } = check()
    expect(ok).toBe(false)
    expect(said).toContain('assets/assistant-A1.js imports assets/Planner-A1.js')
  })
})
