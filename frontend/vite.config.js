import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        // Plan 23 Track B W4: the route split left the entry chunk ~99% stable
        // third-party code (React+Router 53.8 kB gzip, framer-motion 39.1 kB gzip).
        // Without this split every app-only redeploy changes the entry's content
        // hash and forces returning clients to re-download all ~94 kB gzip even
        // though the vendor code is unchanged. Isolating vendor into its own
        // content-hashed chunks keeps it cache-stable across app deploys and
        // shrinks the service-worker precache re-fetch surface on upgrade.
        manualChunks(id) {
          if (id.includes('node_modules/framer-motion') || id.includes('node_modules/motion')) return 'vendor-motion';
          if (
            id.includes('node_modules/react-router') ||
            id.includes('node_modules/react-dom') ||
            id.match(/node_modules\/react\//) ||
            id.includes('node_modules/scheduler')
          ) return 'vendor-react';
        },
      },
    },
  },
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
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,ico,svg,woff2}', 'assets/*.webp'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
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
          {
            // Map provider config (Google Maps vs AMap) — cache so offline
            // Today-tab usage doesn't silently fall back to Google Maps deep
            // links when AMap is the configured provider (e.g. in China).
            urlPattern: ({ url, request }) => (
              request.method === 'GET' &&
              /^\/api\/trips\/[^/]+\/map-config$/.test(url.pathname)
            ),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'trippy-map-config',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 7 * 24 * 60 * 60,
              },
            },
          },
          {
            // Import artifact files (original ticket/booking screenshots) are
            // immutable once uploaded — CacheFirst so tickets open offline.
            urlPattern: ({ url, request }) => (
              request.method === 'GET' &&
              /^\/api\/import\/artifacts\/[^/]+\/files\/\d+$/.test(url.pathname)
            ),
            handler: 'CacheFirst',
            options: {
              cacheName: 'trippy-artifact-files',
              expiration: {
                maxEntries: 60,
                maxAgeSeconds: 365 * 24 * 60 * 60,
              },
            },
          },
          {
            // Manual booking attachments — same immutability rationale.
            urlPattern: ({ url, request }) => (
              request.method === 'GET' &&
              /^\/api\/bookings\/[^/]+\/attachments\/[^/]+$/.test(url.pathname)
            ),
            handler: 'CacheFirst',
            options: {
              cacheName: 'trippy-booking-attachments',
              expiration: {
                maxEntries: 60,
                maxAgeSeconds: 365 * 24 * 60 * 60,
              },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5174,
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
