/** @type {RegExp[]} */
export const pwaNavigateFallbackDenylist = [
  /^\/api/,
  /^\/uploads/,
  /^\/downloads\//,
  /^\/mcp/,
  /^\/oauth\//,
  /^\/.well-known\//,
  /^\/plugin-frame\//,
];

export const pwaManifest = {
  id: '/',
  lang: 'ko',
  name: 'TREK \u2014 Travel Planner',
  short_name: 'TREK',
  description: 'Travel Resource & Exploration Kit',
  theme_color: '#111827',
  background_color: '#0f172a',
  display: 'standalone',
  scope: '/',
  start_url: '/',
  categories: ['travel', 'navigation'],
  icons: [
    { src: 'icons/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png' },
    { src: 'icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
};
