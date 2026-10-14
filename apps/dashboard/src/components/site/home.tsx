'use client';
import { useSession } from '@/stores/session';
import { SiteFooter } from './chrome';
import { Hero } from './hero';
import {
  Faq,
  FeatureGrid,
  FinalCta,
  HowItWorks,
  Marquee,
  Pricing,
  ProductSections,
  Security,
} from './sections';

/** The one-page website at "/": hero, the product in screenshots, pricing, questions and the way in. */
export function HomePage() {
  const signedIn = useSession((s) => s.status === 'ready' && !!s.me);
  return (
    <>
      <main id="main">
        <Hero />
        <Marquee />
        <ProductSections />
        <HowItWorks />
        <FeatureGrid />
        <Security />
        <Pricing />
        <Faq />
        <FinalCta signedIn={signedIn} />
      </main>
      <SiteFooter />
    </>
  );
}
