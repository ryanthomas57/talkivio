import type { NextConfig } from 'next';

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  transpilePackages: ['@talkivio/contracts'],
  // Titles, descriptions, canonical links and sharing tags go in <head> for every client, not streamed after the
  // first paint: crawlers and link previewers that read only the head (and Lighthouse) see them.
  htmlLimitedBots: /.*/,
  // The stylesheet is inlined into the page: no render-blocking CSS request before the first paint on slow phones.
  experimental: { inlineCss: true },
  // The dashboard talks to the API through this same-origin proxy, so session
  // cookies stay first-party and no CORS is needed for REST calls.
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${API_INTERNAL_URL}/api/v1/:path*` },
      // Widget frame + assets for the same-origin live preview in widget settings.
      { source: '/widget/:path*', destination: `${API_INTERNAL_URL}/widget/:path*` },
    ];
  },
  async headers() {
    return [
      // The home page's largest first paint (the hero still): fetched as soon as the response headers arrive.
      {
        source: '/',
        headers: [{ key: 'Link', value: '</site/hero-1440.webp>; rel=preload; as=image; fetchpriority=high' }],
      },
      {
        source: '/((?!widget/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
