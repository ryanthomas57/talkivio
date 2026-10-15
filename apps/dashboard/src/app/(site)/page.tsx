import type { Metadata } from 'next';
import { FAQS } from '@/components/site/faq-data';
import { HomePage } from '@/components/site/home';
import { OG_IMAGE, pageMetadata, siteOrigin, SITE_NAME } from '@/components/site/seo';
import { COMPANY, PLANS, TRIAL_DAYS } from '@/components/site/site-config';

const TITLE = 'Talkivio | Live chat software with real-time visitor tracking';
const DESCRIPTION =
  'See who is on your website right now, with location, IP address and network, and start the conversation in one click. Live chat for support and sales teams. 14-day free trial.';

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({ title: TITLE, description: DESCRIPTION, path: '/' });
}

/** Organization, website, product (with each plan's price) and the FAQ, for search engines. */
async function structuredData() {
  const origin = await siteOrigin();
  const org = `${origin}/#organization`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': org,
        name: SITE_NAME,
        legalName: COMPANY.legalName,
        url: `${origin}/`,
        logo: { '@type': 'ImageObject', url: `${origin}/site/talkivio-logo.png`, width: 256, height: 256 },
        email: COMPANY.supportEmail,
        contactPoint: [
          {
            '@type': 'ContactPoint',
            contactType: 'customer support',
            email: COMPANY.supportEmail,
            availableLanguage: ['English'],
          },
        ],
      },
      {
        '@type': 'WebSite',
        '@id': `${origin}/#website`,
        url: `${origin}/`,
        name: SITE_NAME,
        description: DESCRIPTION,
        inLanguage: 'en',
        publisher: { '@id': org },
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${origin}/#software`,
        name: SITE_NAME,
        url: `${origin}/`,
        description: DESCRIPTION,
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'Live chat software',
        operatingSystem: 'Web',
        image: `${origin}${OG_IMAGE.url}`,
        publisher: { '@id': org },
        featureList: [
          'Real-time visitor list with location, IP address and network',
          'Docked chat windows and a shared inbox',
          'Proactive triggers, departments and routing',
          'Offline messages, chat ratings and analytics',
          'Webhooks, REST API and two-factor sign-in',
        ],
        offers: PLANS.map((p) => ({
          '@type': 'Offer',
          name: `${p.name} plan`,
          description: `${p.blurb} Billed monthly per agent, ${TRIAL_DAYS}-day free trial.`,
          price: p.monthly.toFixed(2),
          priceCurrency: 'USD',
          url: `${origin}/#pricing`,
          category: 'Subscription',
          priceSpecification: {
            '@type': 'UnitPriceSpecification',
            price: p.monthly.toFixed(2),
            priceCurrency: 'USD',
            unitText: 'per agent per month',
          },
        })),
      },
      {
        '@type': 'FAQPage',
        '@id': `${origin}/#faq`,
        mainEntity: FAQS.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  };
}

export default async function Index() {
  // "<" escaped so no string in the data can close the script element.
  const json = JSON.stringify(await structuredData()).replace(/</g, '\\u003c');
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
      <HomePage />
    </>
  );
}
