import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Trippy',
        short_name: 'Trippy',
        description: 'A private collaborative travel itinerary planner.',
        display: 'standalone',
        start_url: '/trips',
        scope: '/',
        theme_color: '#0d0b09',
        background_color: '#0d0b09',
        icons: [
          {
            src: '/trippy-icon.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
          {
            src: '/trippy-icon.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: ({ url, request }) => (
              request.method === 'GET' &&
              /^\/api\/trips\/[^/]+\/detail$/.test(url.pathname)
            ),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'trippy-trip-details',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 7 * 24 * 60 * 60,
              },
              networkTimeoutSeconds: 3,
            },
          },
          {
            urlPattern: ({ url, request }) => (
              request.method === 'GET' &&
              /^\/api\/share\/[^/]+$/.test(url.pathname)
            ),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'trippy-share-details',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 7 * 24 * 60 * 60,
              },
              networkTimeoutSeconds: 3,
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3002',
        changeOrigin: true,
        // Required for SSE streaming (copilot) — disable proxy response buffering
        headers: {
          'X-Accel-Buffering': 'no',
        },
      },
    },
  },
});
