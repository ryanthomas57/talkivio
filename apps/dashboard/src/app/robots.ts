import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/components/site/seo';

/**
 * The public website is crawlable; the signed-in product and its APIs are not. Sign-in and sign-up stay crawlable
 * so search engines read their "noindex" instead of listing the bare URL.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await siteOrigin();
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/realtime/',
          '/overview',
          '/visitors',
          '/inbox',
          '/history',
          '/monitor',
          '/analytics',
          '/shortcuts',
          '/team',
          '/settings',
          '/offline-messages',
          '/onboarding',
          '/billing',
          '/workspaces',
          '/design-system',
        ],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
