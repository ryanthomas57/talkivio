import type { NextConfig } from 'next';

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  transpilePackages: ['@talkivio/contracts'],
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
