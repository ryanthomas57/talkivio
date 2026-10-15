import type { Metadata } from 'next';
import { headers } from 'next/headers';

/**
 * Public origin of this deployment (https://talkivio.com in production). Taken from the reverse proxy's Host header,
 * so the same image serves canonical links, the sitemap and structured data for whichever domain it runs on.
 */
export async function siteOrigin(): Promise<string> {
  const h = await headers();
  const host = (h.get('x-forwarded-host') ?? h.get('host') ?? '').split(',')[0]!.trim();
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return 'https://talkivio.com';
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = (h.get('x-forwarded-proto') ?? (local ? 'http' : 'https')).split(',')[0]!.trim();
  return `${proto === 'http' ? 'http' : 'https'}://${host}`;
}

export const SITE_NAME = 'Talkivio';
export const OG_IMAGE = {
  url: '/site/og.jpg',
  width: 1200,
  height: 630,
  alt: 'Talkivio: live chat with real-time visitor tracking',
};
/** When the public pages last changed meaningfully (sitemap lastModified). */
export const SITE_UPDATED = '2026-10-15';

/** Title, description, canonical URL and sharing tags for one public page. */
export async function pageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): Promise<Metadata> {
  const origin = await siteOrigin();
  return {
    metadataBase: new URL(origin),
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    robots: {
      index: true,
      follow: true,
      googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
    },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      locale: 'en_US',
      url: path,
      title,
      description,
      images: [OG_IMAGE],
    },
    twitter: { card: 'summary_large_image', title, description, images: [OG_IMAGE.url] },
  };
}
