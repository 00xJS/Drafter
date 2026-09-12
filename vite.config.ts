/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  test: {
    // agent worktrees live under .claude/worktrees and carry their own copy of
    // every test; a run from the checkout must not collect theirs too
    exclude: [...configDefaults.exclude, '.claude/**', 'dist/**'],
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
        // the OAuth metadata and endpoints are functions, never the app shell;
        // /oauth/authorize stays in: consent happens inside the app
        navigateFallbackDenylist: [/^\/api\//, /^\/\.well-known\//, /^\/oauth\/(register|token|revoke)$/],
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
