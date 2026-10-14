import Link from 'next/link';
import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from './chrome';
import { COMPANY } from './site-config';

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

/** One legal document: header, title, contents list, numbered sections and the footer with the other documents. */
export function LegalDoc({
  title,
  kicker,
  intro,
  sections,
}: {
  title: string;
  kicker: string;
  intro: ReactNode;
  sections: LegalSection[];
}) {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <article className="site-legal">
          <span className="site-micro site-kicker">{kicker}</span>
          <h1>{title}</h1>
          <p className="site-micro" style={{ color: 'var(--site-subtle)', letterSpacing: '0.16em' }}>
            Last updated {COMPANY.legalUpdated}
          </p>
          {intro}
          <nav className="site-toc" aria-label="Contents">
            <strong>Contents</strong>
            <ol>
              {sections.map((s) => (
                <li key={s.id} style={{ margin: '4px 0' }}>
                  <a href={`#${s.id}`}>{s.title}</a>
                </li>
              ))}
            </ol>
          </nav>
          {sections.map((s, i) => (
            <section key={s.id} aria-labelledby={s.id}>
              <h2 id={s.id}>
                {i + 1}. {s.title}
              </h2>
              {s.body}
            </section>
          ))}
          <p style={{ marginTop: 48, color: 'var(--site-subtle)', fontSize: 14 }}>
            See also: <Link href="/legal/terms">Terms of Use</Link> ·{' '}
            <Link href="/legal/privacy">Privacy Policy</Link> ·{' '}
            <Link href="/legal/refund-policy">Refund Policy</Link>
          </p>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}

export const Mail = ({ to }: { to: string }) => <a href={`mailto:${to}`}>{to}</a>;
