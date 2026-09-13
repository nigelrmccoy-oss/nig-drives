import { defineConfig } from 'vite';

/**
 * Dev proxy for Overpass when a public instance blocks browser CORS.
 * Client tries direct Overpass first; falls back to /api/overpass in dev.
 */
export default defineConfig({
  server: {
    proxy: {
      '/api/overpass': {
        target: 'https://overpass-api.de',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/overpass/, '/api/interpreter'),
      },
      '/api/overpass-kumi': {
        target: 'https://overpass.kumi.systems',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/overpass-kumi/, '/api/interpreter'),
      },
    },
  },
});
