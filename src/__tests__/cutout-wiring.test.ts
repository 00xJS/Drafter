import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CUTOUT_ASSETS, CUTOUT_LOADER, CUTOUT_MODEL, CUTOUT_WASM, MEDIAPIPE_VERSION, MODEL_SHA256 } from '../cutoutassets'

/*
 * The garment cut-out's web engine spans the build, the host and three files
 * that must agree byte for byte with constants in src/cutoutassets.ts. A
 * wrong size is a download refused every time; a precached model is 17.5 MB
 * on every app update; a missing file answered with the app page is a model
 * that is really HTML. So they are read against each other here.
 */

const root = fileURLToPath(new URL('../../', import.meta.url))
const path = (rel: string) => join(root, rel)
const read = (rel: string) => readFileSync(path(rel), 'utf8')
const RUNTIME = 'node_modules/@mediapipe/tasks-vision'

/** Every .ts/.tsx under src, tests aside, as a path from the repo root. */
function sources(dir = path('src')): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full)
    return /\.tsx?$/.test(name) ? [relative(root, full).split(sep).join('/')] : []
  })
}

describe('the build and the host', () => {
  it('copies the runtime in, and keeps every cut-out file out of the precache', () => {
    const vite = read('vite.config.ts')
    expect(vite).toMatch(/plugins: \[\s*react\(\w*\),\s*cutoutRuntime\(\),\s*buildStamp\(\),[\s\S]{0,80}VitePWA\(/)
    const ignores = /globIgnores: \[([^\]]*)\]/.exec(vite)?.[1] ?? ''
    expect(ignores).toContain("'**/node_modules/**/*'")
    expect(ignores).toContain("'cutout/**'")
    expect(vite.match(/workbox:/g)).toHaveLength(1)
  })

  it('answers a missing /cutout/ file with a 404 before the app page can, and serves the rest immutable', () => {
    const netlify = read('netlify.toml')
    const notFound = netlify.indexOf('from = "/cutout/*"')
    expect(notFound).toBeGreaterThan(0)
    expect(netlify.slice(notFound, netlify.indexOf('[[', notFound))).toMatch(/to = "\/cutout\/not-found"\s+status = 404/)
    expect(notFound).toBeLessThan(netlify.indexOf('from = "/*"'))
    expect(netlify).toMatch(/for = "\/cutout\/\*"\s+\[headers\.values\]\s+Cache-Control = "public, max-age=31536000, immutable"/)
  })

  it('fails the build if the cut-out ever reaches the precache', () => {
    const precache = read('scripts/check-precache.mjs')
    expect(precache).toContain("sw.includes('cutout/')")
    expect(precache).toContain('wasm|tflite|onnx|task')
    expect(precache).toContain("'magic-touch-v1', 'magic_touch.tflite'")
    expect(precache).toContain("['vision_wasm_internal.js', 'vision_wasm_internal.wasm']")
  })

  it('holds the whole precache to a byte budget, counted from the files dist/sw.js names', () => {
    const precache = read('scripts/check-precache.mjs')
    const budget = Number(/const PRECACHE_BUDGET_KIB = (\d+)/.exec(precache)?.[1])
    // room for the app to grow, and none for a model or a library to slip in: 17.5 MB would be twelve times over
    expect(budget).toBeGreaterThan(1200)
    expect(budget).toBeLessThanOrEqual(2048)
    expect(precache).toContain('over its budget of')
    expect(precache).toContain('its install would fail')
  })
})

describe('the files match the constants', () => {
  it('pins @mediapipe/tasks-vision exactly, at the version the code names', () => {
    const pinned = JSON.parse(read('package.json')).dependencies['@mediapipe/tasks-vision']
    expect(pinned).toBe(MEDIAPIPE_VERSION)
    expect(JSON.parse(read(`${RUNTIME}/package.json`)).version).toBe(MEDIAPIPE_VERSION)
    expect(CUTOUT_WASM.url).toBe(`/cutout/mediapipe-${MEDIAPIPE_VERSION}/vision_wasm_internal.wasm`)
    expect(CUTOUT_LOADER.url).toBe(`/cutout/mediapipe-${MEDIAPIPE_VERSION}/vision_wasm_internal.js`)
  })

  it('has every byte count right', () => {
    const disk = {
      [CUTOUT_MODEL.url]: path('public/cutout/magic-touch-v1/magic_touch.tflite'),
      [CUTOUT_WASM.url]: path(`${RUNTIME}/wasm/vision_wasm_internal.wasm`),
      [CUTOUT_LOADER.url]: path(`${RUNTIME}/wasm/vision_wasm_internal.js`),
    }
    for (const asset of CUTOUT_ASSETS) expect(statSync(disk[asset.url]).size, asset.url).toBe(asset.bytes)
  })
})

describe('the model', () => {
  it('is the MagicTouch v1 file whose SHA-256 the code pins', () => {
    const model = readFileSync(path('public/cutout/magic-touch-v1/magic_touch.tflite'))
    expect(model.subarray(4, 8).toString('latin1')).toBe('TFL3')
    expect(model.length).toBe(6_227_884)
    expect(createHash('sha256').update(model).digest('hex')).toBe(MODEL_SHA256)
    // the file as downloaded on 2026-09-14 (its MD5, 3b1295f91561c13956cb422f714e2d07,
    // is the one Google's own headers give): a new model means a new folder, never new bytes here
    expect(MODEL_SHA256).toBe('e24338a717c1b7ad8d159666677ef400babb7f33b8ad60c4d96db4ecf694cd25')
    expect(createHash('md5').update(model).digest('hex')).toBe('3b1295f91561c13956cb422f714e2d07')
  })

  it('ships with the Apache licence and a notice naming both parts', () => {
    const licence = read('public/cutout/LICENSE')
    expect(licence).toContain('Apache License')
    expect(licence).toContain('Version 2.0')
    const [ours] = read('public/cutout/NOTICE').split(RUNTIME_HEADING)
    expect(ours).toContain(`MediaPipe Tasks Vision ${MEDIAPIPE_VERSION}`)
    expect(ours).toContain('MagicTouch')
    expect(ours.match(/Apache-2\.0/g)).toHaveLength(2)
  })
})

/*
 * vision_wasm_internal.wasm is a static build of MediaPipe and TensorFlow
 * Lite with the libraries under them, some BSD, MIT or MPL and not Google's.
 * Those licences ask for their notices to travel with the binary, which is
 * served from Netlify and bundled into the iPhone app, and the npm package
 * carries none of them.
 */
const RUNTIME_HEADING = 'Third-party components in the WASM runtime'
/** Each with a notice of its own, reproduced in THIRD_PARTY_LICENSES. */
const NOTICED = ['XNNPACK', 'pthreadpool', 'cpuinfo', 'FP16', 'FXdiv', 'Protocol Buffers', 'Eigen', 'farmhash', 'fft2d', 'Emscripten', 'musl libc']
/** Apache-2.0, so LICENSE covers them; named all the same. */
const APACHE = ['Abseil', 'FlatBuffers', 'ruy', 'gemmlowp', 'OpenCV', 'LLVM libc++']

/*
 * OpenCV keeps its build host's configuration in the binary, the text
 * cv::getBuildInformation() returns. It names what that Linux machine had
 * (/usr/lib/x86_64-linux-gnu/libjpeg.so, libpng.so, libz.so), none of which a
 * WASM can link, so it is left out of the search below; a library is looked
 * for by strings of its own code instead.
 */
const BUILD_INFO = 'General configuration for OpenCV'

describe('the WASM runtime’s own third-party parts', () => {
  const notice = read('public/cutout/NOTICE')
  const runtime = notice.slice(notice.indexOf(RUNTIME_HEADING))
  const texts = read('public/cutout/THIRD_PARTY_LICENSES')
  const flat = texts.replace(/\s+/g, ' ')

  it('are each named in NOTICE, XNNPACK and protobuf among them', () => {
    expect(notice).toContain(RUNTIME_HEADING)
    expect(runtime).toContain('XNNPACK')
    expect(runtime).toContain('protobuf')
    for (const name of [...NOTICED, ...APACHE]) expect(runtime, name).toContain(name)
  })

  it('have their notices and licence texts in THIRD_PARTY_LICENSES, which NOTICE points to', () => {
    expect(runtime).toContain('THIRD_PARTY_LICENSES')
    for (const name of NOTICED) expect(texts, name).toMatch(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`, 'm'))
    expect(flat).toContain('Redistributions in binary form must reproduce the above copyright notice')
    expect(flat).toContain('Neither the name of Google Inc. nor the names of its contributors')
    expect(flat).toContain('Permission is hereby granted, free of charge')
    expect(flat).toContain('You may distribute this ORIGINAL package')
    expect(flat).toContain('LLVM Exceptions to the Apache 2.0 License')
    expect(flat).toContain('Mozilla Public License Version 2.0')
    expect(flat).toContain('Exhibit B - "Incompatible With Secondary Licenses" Notice')
    expect(runtime).toContain('https://gitlab.com/libeigen/eigen')
  })

  it('include everything the binary itself is found to carry', () => {
    const binary = readFileSync(path(`${RUNTIME}/wasm/vision_wasm_internal.wasm`)).toString('latin1')
    // OpenCV's build information is one C string, a few KB, naming the build host's shared libraries
    const start = binary.indexOf(BUILD_INFO)
    const end = binary.indexOf('\0', start)
    expect(start).toBeGreaterThan(0)
    expect(binary.indexOf(BUILD_INFO, end)).toBe(-1)
    expect(end - start).toBeLessThan(16_384)
    for (const so of ['libjpeg.so', 'libpng.so', 'libz.so']) expect(binary.slice(start, end), so).toContain(`/usr/lib/x86_64-linux-gnu/${so}`)
    const wasm = (binary.slice(0, start) + binary.slice(end)).toLowerCase()
    // strings each library's own code leaves (log lines, source paths, error
    // messages, runtime entry points) and the credit it then needs; a hit with
    // no credit is a notice to add
    const markers: [RegExp, string][] = [
      [/xnnpack/, 'XNNPACK'],
      [/pthreadpool/, 'pthreadpool'],
      [/cpuinfo/, 'cpuinfo'],
      [/protobuf/, 'Protocol Buffers'],
      [/eigen/, 'Eigen'],
      [/absl/, 'Abseil'],
      [/flatbuffers/, 'FlatBuffers'],
      [/farmhash/, 'farmhash'],
      [/fft2d/, 'fft2d'],
      [/opencv/, 'OpenCV'],
      [/libjpeg|wrong jpeg library version|jpeg_std_error/, 'libjpeg'],
      [/libpng|png_create_read_struct/, 'libpng'],
      [/zlib|incorrect header check| inflate 1\.| deflate 1\./, 'zlib'],
      [/glog/, 'glog'],
      // MediaPipe's own error for a Halide/vImage converter this build leaves out names it once; its runtime would bring halide_*
      [/halide_/, 'Halide'],
      [/stb_image|stbi_/, 'stb'],
    ]
    const missing = markers.filter(([marker, name]) => marker.test(wasm) && !runtime.includes(name)).map(([, name]) => name)
    expect(missing).toEqual([])
  })
})

describe('privacy: the photo stays on the device', () => {
  const files = [
    'src/cutout.ts',
    'src/cutoutmath.ts',
    'src/cutoutjobs.ts',
    'src/cutout.worker.ts',
    'src/cutoutassets.ts',
    'src/cutoutweb.ts',
    'src/components/CutoutSheet.tsx',
    'src/components/wardrobe/CutoutLater.tsx',
  ]

  it.each(files)('%s talks to no server, no storage and no other host', file => {
    const src = read(file)
    for (const banned of ['/api/', 'supabase', 'saveMedia', 'http:', 'https:']) expect(src, banned).not.toContain(banned)
  })

  it('fetches only our own /cutout/ files', () => {
    for (const asset of CUTOUT_ASSETS) expect(asset.url).toMatch(/^\/cutout\//)
  })
})

describe('the web engine loads only when needed', () => {
  it('is the only module that imports @mediapipe/tasks-vision', () => {
    const importers = sources().filter(file => /from '@mediapipe\/tasks-vision'|import\('@mediapipe\/tasks-vision'\)/.test(read(file)))
    expect(importers).toEqual(['src/cutoutweb.ts'])
  })

  it('is reached only through import() from src/cutout.ts', () => {
    const importers = sources().filter(file => /from '\.{1,2}\/(?:\.\.\/)*cutoutweb'/.test(read(file)))
    expect(importers).toEqual([])
    expect(read('src/cutout.ts')).toContain("import('./cutoutweb')")
    // and it takes nothing but types back from cutout.ts, so there is no cycle at run time
    expect(read('src/cutoutweb.ts')).toMatch(/^import type \{[^}]+\} from '\.\/cutout'$/m)
  })

  it('is reached from the piece sheet only through import(), as from Add clothing', () => {
    const later = read('src/components/wardrobe/CutoutLater.tsx')
    expect(later).not.toMatch(/from '\.\.\/CutoutSheet'|from '\.\.\/\.\.\/cutout'/)
    expect(later).toContain("import('../CutoutSheet')")
    expect(later).toContain("import('../../cutout')")
  })
})

describe('the maths off the page’s thread', () => {
  it('runs in a module worker that Vite builds from the line in cutout.ts that starts it', () => {
    const cutout = read('src/cutout.ts')
    expect(cutout).toContain("new Worker(new URL('./cutout.worker.ts', import.meta.url), { type: 'module' })")
    expect(read('vite.config.ts')).toMatch(/worker: \{ format: 'es' \}/)
    // and in the page, where no worker will start
    expect(cutout).toContain('inPageMath')
  })

  it('never takes MediaPipe, the DOM or the bridge with it: those stay on the main thread', () => {
    for (const file of ['src/cutout.worker.ts', 'src/cutoutjobs.ts']) {
      const src = read(file)
      expect(src, file).not.toMatch(/from '(@mediapipe\/tasks-vision|\.\/cutoutweb|\.\/cutout|\.\/native|react)'/)
      expect(src, file).not.toContain('import(')
    }
    expect(read('src/cutout.worker.ts')).toMatch(/^import \{ answer, type JobRequest \} from '\.\/cutoutjobs'$/m)
    // the web engine hands its masks to the jobs, and takes only a type from them
    expect(read('src/cutoutweb.ts')).toMatch(/^import type \{ CutoutMath \} from '\.\/cutoutjobs'$/m)
  })
})

describe('the styles and the README', () => {
  it('adds one colour, --photo-white, and the cut-out block uses tokens only', () => {
    const base = read('src/styles/01-base.css')
    expect(base.match(/--photo-white:/g)).toHaveLength(1)
    expect(base).toMatch(/--photo-white: #ffffff;/)
    const sheet = read('src/styles/07-dialogs-dashboard.css')
    const block = sheet.slice(sheet.indexOf('/* ---------- garment cut-out ----------')).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(block).toContain('.cutout-white')
    expect(block).toContain('var(--photo-white)')
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })

  it('sends a tap on the photo to Vision’s subjects first, and a key press to the web engine', () => {
    const sheet = read('src/components/CutoutSheet.tsx')
    // a pointer tap carries a point and runs 'auto'; Enter or Space has none and asks the web engine's seeds
    expect(sheet).toContain('web: point === null')
    expect(sheet).toContain("engine: job.web ? 'web' : 'auto'")
    expect(sheet).toContain('if (e.detail === 0) return onPick(null)')
  })

  it('credits the model and its licence in the README', () => {
    const readme = read('README.md')
    expect(readme).toContain('## Garment cut-out')
    expect(readme).toContain('Apache-2.0')
    expect(readme).toContain('MagicTouch')
    expect(readme).toContain('/cutout/THIRD_PARTY_LICENSES')
  })
})
