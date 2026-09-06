import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GH Pages serves from /<repo>/ — override with BASE_PATH at build time.
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  base,
  server: { port: 5290, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5291, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0 },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'models/*.task'],
      manifest: {
        name: 'MediaEditor',
        short_name: 'MediaEditor',
        description: 'Photo editor with layers, drawing, shapes, text, age transform and multi-format export.',
        theme_color: '#0f1115',
        background_color: '#0f1115',
        display: 'standalone',
        orientation: 'any',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // Precache the app shell only. The face runtime (11MB wasm + 3.6MB model)
        // is cached on first use instead, so installing the PWA stays fast and
        // the face tools still work offline once you have used them once.
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        globIgnores: ['**/mediapipe/**', '**/models/**'],
        navigateFallbackDenylist: [/^\/(mediapipe|models)\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /\/(mediapipe|models)\//.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'mediaeditor-face-runtime',
              expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] },
              rangeRequests: true
            }
          }
        ]
      }
    })
  ]
});
