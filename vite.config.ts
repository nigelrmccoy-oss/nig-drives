import { defineConfig } from 'vite';

/**
 * Dev proxies for Overpass when public instances block browser CORS or TLS fails
 * (e.g. Cursor box → overpass-api.de unexpected EOF).
 *
 * Primary /api/overpass → kumi (healthy here).
 * Secondary /api/overpass-mailru → maps.mail.ru.
 * Last-resort /api/overpass-de → overpass-api.de (often broken on this env).
 * Legacy /api/overpass-kumi kept as kumi alias.
 *
 * Use ^…$ contexts so `/api/overpass` does not prefix-match `/api/overpass-*`.
 *
 * base: './' so Electron loadFile() resolves assets under dist/ (file://).
 * Also works for static hosting and `npm run preview`.
 */
export default defineConfig({
  base: './',
  server: {
    proxy: {
      '^/api/overpass-mailru$': {
        target: 'https://maps.mail.ru',
        changeOrigin: true,
        rewrite: () => '/osm/tools/overpass/api/interpreter',
      },
      '^/api/overpass-kumi$': {
        target: 'https://overpass.kumi.systems',
        changeOrigin: true,
        rewrite: () => '/api/interpreter',
      },
      '^/api/overpass-de$': {
        target: 'https://overpass-api.de',
        changeOrigin: true,
        rewrite: () => '/api/interpreter',
      },
      '^/api/overpass$': {
        target: 'https://overpass.kumi.systems',
        changeOrigin: true,
        rewrite: () => '/api/interpreter',
      },
    },
  },
});
