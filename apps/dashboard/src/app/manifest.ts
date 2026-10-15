import type { MetadataRoute } from 'next';

/** Lets agents add the dashboard to a phone's home screen; also gives browsers the brand name and colours. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Talkivio', // i18n-ignore (brand name)
    short_name: 'Talkivio', // i18n-ignore (brand name)
    description: 'Live chat with real-time visitor tracking', // i18n-ignore (English-only, like the public site)
    start_url: '/inbox',
    scope: '/',
    display: 'standalone',
    background_color: '#05070a',
    theme_color: '#07778A',
    icons: [
      { src: '/icon.png', sizes: '192x192', type: 'image/png' },
      { src: '/apple-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  };
}
