import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Drafter',
        short_name: 'Drafter',
        description: 'Plan, draft, and track social media posts',
        theme_color: '#4f46e5',
        background_color: '#f9f9f7',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5174',
        // keep the dev console quiet when the sync server isn't running
        configure: proxy => {
          proxy.on('error', () => {})
        },
      },
    },
  },
})
