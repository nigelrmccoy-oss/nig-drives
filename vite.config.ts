import { defineConfig } from 'vite';

/**
 * Same-origin proxies for the public Overpass mirrors (dev server and
 * `vite preview`, which inherits server.proxy): no CORS, and a real
 * identifying User-Agent — overpass-api.de answers 406 and kumi /
 * private.coffee 429 to clients without one. Order of use is decided in
 * OverpassClient (v1.3.5: overpass-api.de → maps.mail.ru → kumi →
 * private.coffee). Use ^…$ contexts so `/api/overpass` does not
 * prefix-match `/api/overpass-*`.
 *
 * base: './' so Electron loadFile() resolves assets under dist/ (file://).
 * Also works for static hosting and `npm run preview`.
 */
const OVERPASS_UA = 'nig-drives/1.3.11 (+https://github.com/nigelrmccoy-oss/nig-drives)';

function overpassProxy(target: string, path: string) {
  return {
    target,
    changeOrigin: true,
    rewrite: () => path,
    headers: { 'User-Agent': OVERPASS_UA },
    timeout: 60_000,
    proxyTimeout: 60_000,
  };
}

export default defineConfig({
  base: './',
  server: {
    proxy: {
      '^/api/overpass-de$': overpassProxy('https://overpass-api.de', '/api/interpreter'),
      '^/api/overpass-mailru$': overpassProxy('https://maps.mail.ru', '/osm/tools/overpass/api/interpreter'),
      '^/api/overpass-kumi$': overpassProxy('https://overpass.kumi.systems', '/api/interpreter'),
      '^/api/overpass-coffee$': overpassProxy('https://overpass.private.coffee', '/api/interpreter'),
      // legacy alias (≤ v1.3.4 clients)
      '^/api/overpass$': overpassProxy('https://overpass-api.de', '/api/interpreter'),
    },
  },
});
