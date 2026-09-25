import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin, type Rolldown } from 'vite'
import { configDefaults } from 'vitest/config'
import babel from '@rolldown/plugin-babel'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { cspHeadersFile } from './shared/csp.mts'
import { planChunks } from './scripts/lib/chunkplan.mjs'

// Every build is stamped (src/appupdate.ts): index.html carries the stamp the
// page was built with, /version.json the one the server has now. Netlify's
// deploy id, else the commit, else the time of a local build.
const BUILD_ID = process.env.DEPLOY_ID || process.env.COMMIT_REF || `local-${Date.now().toString(36)}`

/**
 * Apple's site association file, written from APPLE_TEAM_ID.
 *
 * Universal Links (a drafterz.netlify.app URL opening in the app rather than
 * Safari) and Password AutoFill both need /.well-known/apple-app-site-association
 * served from the site as JSON, naming <team>.<bundle>. The team id is not a
 * secret but it is per-account, so it comes from the environment rather than
 * being committed — and without it NO file is emitted at all, which is the
 * right failure: a half-written association is worse than none, because iOS
 * caches what it fetches and a wrong appID silently stops links working.
 *
 * The matching capability is in ios/App/App/App.entitlements.
 */
const APPLE_TEAM_ID = (process.env.APPLE_TEAM_ID ?? '').trim()
const APPLE_BUNDLE_ID = (process.env.APPLE_BUNDLE_ID ?? 'app.drafter.ios').trim()

const appleSiteAssociation = (): Plugin => ({
  name: 'drafter-apple-app-site-association',
  apply: 'build',
  generateBundle() {
    if (!APPLE_TEAM_ID) return
    const appID = `${APPLE_TEAM_ID}.${APPLE_BUNDLE_ID}`
    const body = {
      applinks: {
        details: [{ appIDs: [appID], components: [{ '/': '/', comment: "Drafter's links all sit on the root with a query: ?view=, ?task=, ?saw=, ?plan=" }] }],
      },
      webcredentials: { apps: [appID] },
    }
    // no extension: Apple fetches this exact path
    this.emitFile({ type: 'asset', fileName: '.well-known/apple-app-site-association', source: `${JSON.stringify(body, null, 2)}\n` })
  },
})

const buildStamp = (): Plugin => ({
  name: 'drafter-build-stamp',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'drafter-build', content: BUILD_ID }, injectTo: 'head' }],
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ build: BUILD_ID })}\n` })
  },
})

/**
 * The Content-Security-Policy, written to dist/_headers (shared/csp.mts holds
 * the policy and why each source is in it). It is written here because two
 * of its pieces only the build knows: the Supabase project the bundle talks to
 * (VITE_SUPABASE_URL) and the hash of the built index.html's inline script.
 * Reported only, until the host sets CSP_ENFORCE=true. Not for the iPhone
 * build: Capacitor serves that bundle itself and reads no _headers.
 */
const contentSecurityPolicy = (): Plugin => {
  let mode = ''
  let supabaseUrl = ''
  let enforced = false
  return {
    name: 'drafter-content-security-policy',
    apply: 'build',
    // after vite:build-html, so the page it hashes is the one that ships
    enforce: 'post',
    configResolved(config) {
      mode = config.mode
      supabaseUrl = String(config.env.VITE_SUPABASE_URL ?? '')
      enforced = /^(1|true|yes)$/i.test((process.env.CSP_ENFORCE ?? '').trim())
    },
    generateBundle(_, bundle) {
      if (mode === 'ios') return
      const page = bundle['index.html']
      if (page?.type !== 'asset') return this.error('the Content-Security-Policy hashes index.html, and this build wrote none')
      const sha256 = (text: string) => createHash('sha256').update(text).digest('base64')
      this.emitFile({ type: 'asset', fileName: '_headers', source: cspHeadersFile({ html: String(page.source), supabaseUrl, enforce: enforced, sha256 }) })
    },
  }
}

// The garment cut-out's web runtime (src/cutoutweb.ts): two files from
// @mediapipe/tasks-vision, served from our own origin in a versioned folder,
// dist/cutout/mediapipe-<version>/, and never precached (globIgnores below).
// The version is the installed package's, so the WASM always matches its JS,
// and 12 MB of binary stays out of git.
const CUTOUT_RUNTIME = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']

const cutoutRuntime = (): Plugin => {
  const pkg = fileURLToPath(new URL('./node_modules/@mediapipe/tasks-vision/', import.meta.url))
  // read when first needed, not when this file loads: vitest loads it too
  const version = (): string => {
    if (!existsSync(`${pkg}package.json`)) throw new Error('@mediapipe/tasks-vision is not installed; run npm ci')
    return JSON.parse(readFileSync(`${pkg}package.json`, 'utf8')).version
  }
  const file = (name: string) => readFileSync(`${pkg}wasm/${name}`)
  return {
    name: 'drafter-cutout-runtime',
    configureServer(server) {
      // Dev: the two runtime files straight from node_modules. Any other
      // /cutout/ path that is not a real file in public/ is a 404, as on
      // Netlify, never the app's page with a 200.
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (!path.startsWith('/cutout/')) return next()
        const runtime = /^\/cutout\/mediapipe-([^/]+)\/([^/]+)$/.exec(path)
        if (runtime && CUTOUT_RUNTIME.includes(runtime[2]) && existsSync(`${pkg}package.json`) && runtime[1] === version()) {
          res.setHeader('Content-Type', runtime[2].endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
          res.end(file(runtime[2]))
          return
        }
        if (!runtime && existsSync(join(server.config.publicDir, path))) return next()
        res.statusCode = 404
        res.end()
      })
    },
    generateBundle() {
      for (const name of CUTOUT_RUNTIME) this.emitFile({ type: 'asset', fileName: `cutout/mediapipe-${version()}/${name}`, source: file(name) })
    },
  }
}

/**
 * The React Compiler memoises the app's components and hooks as it builds them,
 * and eslint-plugin-react-hooks reports what it would refuse (a component it
 * cannot prove safe is left as written; scripts/compiler-check.mjs keeps count).
 * Babel runs it, over the files the React plugin gave it before that plugin
 * dropped Babel: .ts, .tsx, .js and .jsx outside node_modules, never the .mts
 * rules in shared/. The preset keeps it out of server-side transforms, which is
 * how vitest loads modules for a test in node: those run the components as
 * written. The DOM tests (*.dom.test.tsx, in happy-dom) load them as a browser
 * does, and run what the compiler made of them, as the browser tests (npm run
 * e2e) do.
 */
const reactCompiler = () => babel({ include: /\.[jt]sx?(?:$|\?)/, presets: [reactCompilerPreset()] })

/**
 * Lazy chunks that only work online, so they are kept out of the precache
 * (the budget in scripts/check-precache.mjs, which keeps the same list): Admin,
 * whose every panel reads or writes through /api/admin, and the garment
 * cut-out's web runtime, whose WASM and model come from the network on first
 * use anyway (cutout/ is never precached). Each is fetched when first opened.
 */
const ONLINE_ONLY_CHUNKS = ['Admin', 'cutoutweb']

/** The assistant's own modules: the lazy views load them, the launch never does (see chunkFileNames below). */
const ASSISTANT_MODULE = /\/src\/(ai|ask|chatactions|recipefill|recipeimport)\.ts$/

/**
 * What a signed-in launch loads first — the page's entry and the Planner — and
 * which of its modules go in the one stable chunk the lazy views share it
 * through (scripts/lib/chunkplan.mjs, which says why). Worked out once per
 * chunking pass: Rolldown hands back the same module objects within one.
 */
const ROOT = fileURLToPath(new URL('./', import.meta.url))
const LAUNCH_ROOTS = { page: join(ROOT, 'index.html'), planner: join(ROOT, 'src/components/Planner.tsx') }
const isPackage = (id: string) => /[\\/]node_modules[\\/]/.test(id)
const plans = new WeakMap<object, ReturnType<typeof planChunks>>()
function chunkPlan(ctx: Rolldown.ChunkingContext): ReturnType<typeof planChunks> | null {
  const key = ctx.getModuleInfo(LAUNCH_ROOTS.page)
  if (!key) return null
  let plan = plans.get(key)
  if (!plan) plans.set(key, (plan = planChunks(id => ctx.getModuleInfo(id), LAUNCH_ROOTS, isPackage)))
  return plan
}
/** A shared module that names a lazy chunk gets a chunk of its own, called after it: calendarstate.ts, calendarstate-[hash].js. */
const ownChunkName = (id: string) => id.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '')

export default defineConfig({
  test: {
    // agent worktrees live under .claude/worktrees and carry their own copy of
    // every test; a run from the checkout must not collect theirs too. e2e/ is
    // Playwright's (npm run e2e), in a browser, not vitest's.
    exclude: [...configDefaults.exclude, '.claude/**', 'dist/**', 'e2e/**'],
    // the build host carries the site's real environment (Netlify runs `npm run
    // check` with BACKUP_PASSPHRASE set); setup.ts decides what a test sees
    // rather than letting it inherit whatever the machine happens to hold
    setupFiles: ['./src/__tests__/setup.ts'],
    // Node, with no document. A *.dom.test.tsx says `// @vitest-environment
    // happy-dom` on its first line and runs in one instead (src/__tests__/dom.ts).
    environment: 'node',
  },
  plugins: [
    react(),
    reactCompiler(),
    cutoutRuntime(),
    buildStamp(),
    appleSiteAssociation(),
    contentSecurityPolicy(),
    VitePWA({
      registerType: 'autoUpdate',
      // the app registers the worker itself and watches for deploys (src/appupdate.ts)
      injectRegister: false,
      // Only the favicon is precached. The PNG icons (200 KiB of the budget)
      // are read when the app is installed or added to a Home Screen, which
      // happens online; an offline launch never asks for them.
      includeAssets: ['icon.svg'],
      includeManifestIcons: false,
      manifest: {
        name: 'Drafter',
        short_name: 'Drafter',
        description: 'Home journal and planner: Home, Calendar, Tasks, Keep and Insights, with habits, routines and a weekly review',
        share_target: {
          action: '/',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
        // The light ground the app opens in (THEME_GROUND.light in src/theme.ts;
        // launchscreen.test.ts holds them equal). A manifest cannot follow
        // Settings → Appearance: the live <meta name="theme-color"> does, and
        // browsers take it over theme_color. background_color is the install splash.
        theme_color: '#f6f7f9',
        background_color: '#f6f7f9',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // one workbox block only — a second key would silently replace this one
      // and drop importScripts, leaving the service worker with no push handler
      workbox: {
        importScripts: ['sw-push.js'],
        // a new worker takes over as soon as it has installed; the page moves onto it
        skipWaiting: true,
        clientsClaim: true,
        // Pages come from the network first, so a refresh is always the newest
        // deploy; offline, or with no answer in 3 seconds, the saved copy. The
        // hashed files a page names stay precached for offline launches. No
        // directoryIndex: the precache would otherwise answer "/" with its own
        // index.html before the network is asked.
        navigateFallback: null,
        directoryIndex: null,
        // The garment cut-out's model and WASM (dist/cutout/, 17.5 MB) load on
        // first use into their own cache (src/cutoutassets.ts): precached, every
        // app update would download them. workbox's only default ignore is the
        // node_modules one, so it is kept.
        //
        // Chunks that only work online are not precached either: each is
        // fetched the first time it is used, into a cache of its own, below.
        // scripts/check-precache.mjs holds the same list, and fails the build
        // if one is loaded at launch or imported by anything precached.
        globIgnores: ['**/node_modules/**/*', 'cutout/**', ...ONLINE_ONLY_CHUNKS.map(name => `assets/${name}-*.js`)],
        runtimeCaching: [
          {
            // hashed, so a copy never goes stale: a new deploy is a new name
            urlPattern: new RegExp(`/assets/(${ONLINE_ONLY_CHUNKS.join('|')})-[\\w-]+\\.js$`),
            handler: 'CacheFirst',
            options: { cacheName: 'drafter-online-only', expiration: { maxEntries: 8 } },
          },
          {
            // the OAuth metadata and endpoints are functions, never the app shell;
            // /oauth/authorize stays in: consent happens inside the app
            urlPattern: ({ request, url }) =>
              request.mode === 'navigate' && !/^\/(api\/|\.well-known\/|oauth\/(register|token|revoke)$)/.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'drafter-pages',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 8 },
              precacheFallback: { fallbackURL: 'index.html' },
            },
          },
        ],
      },
    }),
  ],
  // the garment cut-out's maths runs in a module worker (src/cutout.worker.ts),
  // built as an ES module so it loads the way the page's own chunks do
  worker: { format: 'es' },
  build: {
    // Vite 7's defaults. The iPhone app runs from iOS 16.0 (the deployment
    // target in ios/App), whose web view is Safari 16.0, and Vite 8's default
    // starts at Safari 16.4: its CSS minifier then writes every media query in
    // the range form, (width<=640px), which Safari reads only from 16.4, so an
    // iPhone on 16.0 to 16.3 would lose the whole phone layout.
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // stable vendor chunks survive app-code deploys in the service-worker cache
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom)[\\/]/, priority: 3 },
            { name: 'vendor-supabase', test: /node_modules[\\/]@supabase[\\/]/, priority: 3 },
            // the iOS bridge's core, which each of its plugins' own chunks
            // imports: apart, those chunks name nothing an app deploy changes
            { name: 'vendor-capacitor', test: /node_modules[\\/]@capacitor[\\/]core[\\/]/, priority: 3 },
            // What the lazy views share with the entry and the Planner, in a
            // stable chunk that names no lazy chunk, so a deploy renames only
            // what it changed (scripts/lib/chunkplan.mjs). They took it from
            // the entry and the Planner chunks themselves, and were renamed
            // with them on every deploy: 86 of 115 precached files. In two
            // halves: the page's, which loads before anything draws, and the
            // Planner's, which a sign-in page does not wait on.
            { name: (id, ctx) => (chunkPlan(ctx)?.page.has(id) ? 'app' : null), debugName: 'app', priority: 2 },
            { name: (id, ctx) => (chunkPlan(ctx)?.planner.has(id) ? 'app-planner' : null), debugName: 'app-planner', priority: 2 },
            // …and one of those that does name a lazy chunk, in a chunk of its own
            { name: (id, ctx) => (chunkPlan(ctx)?.hubs.has(id) ? ownChunkName(id) : null), debugName: 'shared', priority: 2 },
            // Everything else the page imports statically, in the entry. Left
            // to itself, Rolldown splits what the entry shares with the lazy
            // views into chunks of their own, and the page fetched eight more
            // files before it could draw; Rollup kept them in the entry, as
            // this does. scripts/check-precache.mjs fails a build whose launch
            // loads more.
            { name: 'index', tags: ['$initial'], priority: 1 },
          ],
        },
        // The assistant's code — its prompts and parsers (ai.ts), the retrieval
        // Ask runs over the device (ask.ts), the chat's actions and the recipe
        // fill and import — is loaded by a dozen lazy views and by nothing the
        // launch draws. A chunk that is the assistant's (its entry is one of
        // those modules, or it has no entry and holds one) is NAMED for it, so
        // scripts/check-precache.mjs can hold it out of the launch. It is not a
        // group above: a group takes in every module the assistant imports too
        // (the API and Supabase clients, the schema, the kitchen…), and the
        // entry, which needs those, then loaded the whole assistant first —
        // what 3d22024 shipped.
        chunkFileNames: chunk =>
          (chunk.facadeModuleId ? ASSISTANT_MODULE.test(chunk.facadeModuleId) : chunk.moduleIds.some(id => ASSISTANT_MODULE.test(id)))
            ? 'assets/assistant-[hash].js'
            : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5174',
        // keep the dev console quiet when nothing serves /api locally
        configure: proxy => {
          proxy.on('error', () => {})
        },
      },
    },
  },
})
