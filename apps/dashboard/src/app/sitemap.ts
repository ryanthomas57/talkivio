import type { MetadataRoute } from 'next';
import { COMPANY } from '@/components/site/site-config';
import { SITE_UPDATED, siteOrigin } from '@/components/site/seo';

/** The public pages, for search engines. The product behind sign-in is not listed. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteOrigin();
  const legal = new Date(`${COMPANY.legalUpdated} 00:00 UTC`);
  return [
    { url: `${origin}/`, lastModified: new Date(`${SITE_UPDATED}T00:00:00Z`), changeFrequency: 'weekly', priority: 1 },
    { url: `${origin}/legal/terms`, lastModified: legal, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${origin}/legal/privacy`, lastModified: legal, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${origin}/legal/refund-policy`, lastModified: legal, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
