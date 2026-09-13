/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Every build is stamped (src/appupdate.ts): index.html carries the stamp the
// page was built with, /version.json the one the server has now. Netlify's
// deploy id, else the commit, else the time of a local build.
const BUILD_ID = process.env.DEPLOY_ID || process.env.COMMIT_REF || `local-${Date.now().toString(36)}`

const buildStamp = (): Plugin => ({
  name: 'drafter-build-stamp',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'drafter-build', content: BUILD_ID }, injectTo: 'head' }],
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ build: BUILD_ID })}\n` })
  },
})

export default defineConfig({
  test: {
    // agent worktrees live under .claude/worktrees and carry their own copy of
    // every test; a run from the checkout must not collect theirs too
    exclude: [...configDefaults.exclude, '.claude/**', 'dist/**'],
  },
  plugins: [
    react(),
    buildStamp(),
    VitePWA({
      registerType: 'autoUpdate',
      // the app registers the worker itself and watches for deploys (src/appupdate.ts)
      injectRegister: false,
      includeAssets: ['icon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Drafter',
        short_name: 'Drafter',
        description: 'Home journal and planner: Home, Tasks, Calendar, People and Kitchen, with habits, routines and a weekly review',
        share_target: {
          action: '/',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
        theme_color: '#0f1115',
        background_color: '#0f1115',
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
        runtimeCaching: [
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
  build: {
    rollupOptions: {
      output: {
        // stable vendor chunks survive app-code deploys in the service-worker cache
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-supabase': ['@supabase/supabase-js'],
        },
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
