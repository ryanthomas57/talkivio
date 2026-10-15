'use client';
/*
  The home page after the hero. Every picture is a screenshot of the product itself (captured from a demo
  workspace by scripts/site-shots.mjs), and every claim maps to something the product does today.
*/
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { FAQS } from './faq-data';
import { COMPANY, PLANS, TRIAL_DAYS, TRIAL_REMINDER_DAYS, usd, type Cycle } from './site-config';

/** Fade and lift into place the first time a block scrolls into view. */
function Reveal({
  children,
  delay = 0,
  className,
  y = 28,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  y?: number;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.9, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** A product screenshot in a window frame, with a slow parallax tilt as it enters. */
function Shot({
  src,
  alt,
  width,
  height,
  priority,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  priority?: boolean;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.figure
      className="site-shot m-0"
      initial={reduced ? false : { opacity: 0, y: 60, rotateX: 8, scale: 0.97 }}
      whileInView={{ opacity: 1, y: 0, rotateX: 0, scale: 1 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
      style={{ transformPerspective: 1400 }}
    >
      <div className="site-chrome" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        srcSet={[640, 768, 960, 1200]
          .map((w) => `${src.replace(/\.webp$/, `-${w}.webp`)} ${w}w`)
          .concat(`${src} 1600w`)
          .join(', ')}
        sizes="(min-width: 1240px) 700px, (min-width: 1024px) 57vw, calc(100vw - 36px)"
        alt={alt}
        width={width}
        height={height}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
      />
    </motion.figure>
  );
}

function Check() {
  return (
    <svg className="site-check" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="9" stroke="currentColor" strokeOpacity="0.35" />
      <path
        d="M6 10.4l2.6 2.6L14 7.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Kicker({ children }: { children: ReactNode }) {
  return <span className="site-micro site-kicker">{children}</span>;
}

const CAPABILITIES = [
  'Real-time visitor list',
  'IP and network lookup',
  'Docked chat windows',
  'File sharing',
  'Proactive triggers',
  'Departments and routing',
  'Offline messages',
  'Chat ratings',
  'Supervisor monitor',
  'Webhooks and REST API',
  'Two-factor sign-in',
  'Privacy requests',
];

export function Marquee() {
  const row = [...CAPABILITIES, ...CAPABILITIES];
  return (
    <div
      className="relative overflow-hidden border-y border-[var(--site-line)] py-6"
      aria-label="Capabilities"
    >
      <div className="site-marquee">
        {row.map((c, i) => (
          <span
            key={i}
            aria-hidden={i >= CAPABILITIES.length}
            className="site-micro flex items-center gap-14 whitespace-nowrap text-[var(--site-muted)]"
          >
            {c}
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--site-teal)] opacity-70" />
          </span>
        ))}
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-24 bg-gradient-to-r from-[var(--site-ink)] to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-24 bg-gradient-to-l from-[var(--site-ink)] to-transparent" />
    </div>
  );
}

function FeatureSplit({
  id,
  kicker,
  title,
  lead,
  points,
  shot,
  flip,
}: {
  id: string;
  kicker: string;
  title: ReactNode;
  lead: string;
  points: string[];
  shot: ReactNode;
  flip?: boolean;
}) {
  return (
    <section id={id} className="site-section" style={{ scrollMarginTop: 40 }}>
      <div
        className="site-glow"
        style={{
          width: 520,
          height: 520,
          background: flip ? '#6a44c9' : '#05b0bd',
          top: 80,
          [flip ? 'left' : 'right']: -160,
          opacity: 0.22,
        }}
      />
      <div className="site-wrap grid grid-cols-1 items-center gap-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Reveal className={flip ? 'lg:order-2' : undefined}>
          <Kicker>{kicker}</Kicker>
          <h2 className="site-h2">{title}</h2>
          <p className="site-lead">{lead}</p>
          <ul className="mt-8 space-y-3.5 p-0">
            {points.map((p) => (
              <li
                key={p}
                className="flex list-none gap-3 text-[15px] font-light leading-6 text-[var(--site-muted)]"
              >
                <Check />
                {p}
              </li>
            ))}
          </ul>
        </Reveal>
        <div className={flip ? 'lg:order-1' : undefined}>{shot}</div>
      </div>
    </section>
  );
}

export function ProductSections() {
  return (
    <>
      <FeatureSplit
        id="product"
        kicker="01 Visitors"
        title={
          <>
            Know who is on your website <em>right now.</em>
          </>
        }
        lead="Every visitor appears the moment they land, grouped the way you like, with the details that tell you who to talk to first."
        points={[
          'Country, city, browser and device for every visitor',
          'IP address and network owner, so a VPN or a data centre stands out',
          'The page they are reading, where they came from and how long they have stayed',
          'Group by status, page or country, and filter down to the visitors that matter',
          'Click any visitor and a chat window opens on the spot',
        ]}
        shot={
          <Shot
            src="/site/shot-visitors.webp"
            alt="Talkivio Visitors list showing live visitors grouped by status with location, IP address and network"
            width={1600}
            height={1000}
          />
        }
      />
      <FeatureSplit
        id="conversations"
        flip
        kicker="02 Conversations"
        title={
          <>
            Chat windows that <em>stay out of the way.</em>
          </>
        }
        lead="Conversations open in docked windows at the bottom of the screen, so you can keep watching visitors while you talk. New requests pop up with one Accept button."
        points={[
          'Several chats at once, each in its own window or tab',
          'Send and receive files and images, scanned for viruses before anyone opens them',
          'Edit the visitor name, email, phone and private notes beside the conversation',
          'Canned responses with shortcuts, internal notes and transfers between agents',
          'A shared inbox and full history for everything that came before',
        ]}
        shot={
          <Shot
            src="/site/shot-chat.webp"
            alt="A Talkivio chat window docked over the dashboard with the visitor's details beside the conversation"
            width={1600}
            height={1000}
          />
        }
      />
      <FeatureSplit
        id="widget"
        kicker="03 Your website"
        title={
          <>
            A chat widget your visitors <em>actually use.</em>
          </>
        }
        lead="Fast, accessible and on brand. The widget loads in the background, matches your colours, speaks your visitors' language and works with a keyboard or a screen reader."
        points={[
          'Your colours, position, greeting and pre-chat form',
          'Nine languages, including right-to-left Arabic',
          'Offline form when nobody is online, with replies by email',
          'Proactive messages triggered by page, time on page or country',
          'Visitors can download their transcript or have it emailed',
        ]}
        shot={
          <Shot
            src="/site/shot-widget.webp"
            alt="The Talkivio chat widget open on a website, mid conversation"
            width={1600}
            height={1000}
          />
        }
      />
    </>
  );
}

const STEPS = [
  {
    n: '01',
    title: 'Start your free trial',
    body: `Create your workspace, choose a plan and add a card. Nothing is charged for ${TRIAL_DAYS} days.`,
  },
  {
    n: '02',
    title: 'Paste one snippet',
    body: 'Copy the install code into your website once. The dashboard confirms the moment the widget is live.',
  },
  {
    n: '03',
    title: 'Start the conversation',
    body: 'Visitors appear in real time. Invite your team, pick a visitor and say hello.',
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="site-section" style={{ scrollMarginTop: 40 }}>
      <div className="site-wrap">
        <Reveal className="max-w-3xl">
          <Kicker>How it works</Kicker>
          <h2 className="site-h2">
            Live on your website <em>in five minutes.</em>
          </h2>
        </Reveal>
        <div className="mt-16 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="grid grid-cols-1 gap-5">
            {STEPS.map((s, i) => (
              <Reveal key={s.n} delay={i * 0.12}>
                <div className="site-card flex gap-5 p-6 sm:gap-6 sm:p-7">
                  <span className="text-[38px] font-extralight leading-none text-[var(--site-teal)]">
                    {s.n}
                  </span>
                  <div>
                    <h3 className="m-0 text-[19px] font-normal">{s.title}</h3>
                    <p className="mt-2 text-[15px] font-light leading-6 text-[var(--site-muted)]">{s.body}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal delay={0.2}>
            <div className="site-card h-full overflow-hidden">
              <div className="site-chrome" aria-hidden="true">
                <span />
                <span />
                <span />
                <span className="site-micro ml-3 !h-auto !w-auto !rounded-none !bg-transparent text-[var(--site-subtle)]">
                  index.html
                </span>
              </div>
              <pre className="m-0 overflow-x-auto p-5 font-mono text-[12px] leading-6 text-[var(--site-muted)] sm:p-7 sm:text-[13px] sm:leading-7">
                <code>
                  <span className="text-[var(--site-subtle)]">{'<!-- Talkivio chat -->'}</span>
                  {'\n'}
                  <span className="text-[var(--site-violet)]">{'<script>'}</span>
                  {
                    '\n  window.Talkivio = window.Talkivio || function () {\n    (window.Talkivio.q = window.Talkivio.q || []).push(arguments);\n  };\n'
                  }
                  <span className="text-[var(--site-violet)]">{'</script>'}</span>
                  {'\n'}
                  <span className="text-[var(--site-violet)]">{'<script '}</span>
                  {'async src="'}
                  <span className="text-[var(--site-teal)]">{'https://widget.talkivio.com/loader.js'}</span>
                  {'"\n        data-site-key="'}
                  <span className="text-[var(--site-teal)]">{'your-site-key'}</span>
                  {'"'}
                  <span className="text-[var(--site-violet)]">{'></script>'}</span>
                </code>
              </pre>
              <div className="mx-7 mb-7 flex items-center gap-3 rounded-xl border border-[rgba(55,229,231,0.3)] bg-[rgba(55,229,231,0.08)] px-4 py-3 text-[14px]">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--site-teal)] opacity-60 motion-reduce:animate-none" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--site-teal)]" />
                </span>
                Widget detected on your website. You are live.
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

const GRID = [
  {
    t: 'Departments and routing',
    d: 'Send chats to Sales, Support or Billing, each with its own agents, hours and limits.',
  },
  {
    t: 'Proactive triggers',
    d: 'Greet visitors automatically by page, time on page, country or returning visit.',
  },
  {
    t: 'Business hours',
    d: 'Set opening times per department. Outside them the widget collects an offline message.',
  },
  { t: 'Canned responses', d: 'Answer common questions with a shortcut, shared across the team.' },
  { t: 'Supervisor monitor', d: 'Watch live conversations, step in, or transfer a chat to someone else.' },
  {
    t: 'Analytics and ratings',
    d: 'Chat volume, response and wait times, missed chats and visitor satisfaction.',
  },
  {
    t: 'Chat history',
    d: 'Search every conversation by visitor, agent, tag or text, and export transcripts.',
  },
  {
    t: 'Webhooks and REST API',
    d: 'Signed webhooks and scoped API tokens to connect your CRM, helpdesk or data warehouse.',
  },
  {
    t: 'Custom fields and tags',
    d: 'Collect the details your team needs and label conversations for reporting.',
  },
];

export function FeatureGrid() {
  return (
    <section id="features" className="site-section" style={{ scrollMarginTop: 40 }}>
      <div className="site-wrap">
        <Reveal className="max-w-3xl">
          <Kicker>04 Automation</Kicker>
          <h2 className="site-h2">
            Everything a support team needs, <em>nothing it does not.</em>
          </h2>
        </Reveal>
        <div className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-[22px] border border-[var(--site-line)] bg-[var(--site-line)] sm:grid-cols-2 lg:grid-cols-3">
          {GRID.map((g, i) => (
            <Reveal key={g.t} delay={(i % 3) * 0.08} y={18}>
              <div className="group h-full bg-[var(--site-ink-2)] p-8 transition-colors hover:bg-[var(--site-ink-3)]">
                <div className="mb-5 h-px w-10 bg-[var(--site-teal)] transition-all duration-500 group-hover:w-20" />
                <h3 className="m-0 text-[17px] font-normal">{g.t}</h3>
                <p className="mt-2.5 text-[14.5px] font-light leading-6 text-[var(--site-muted)]">{g.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

const SECURITY = [
  {
    t: 'Workspace isolation',
    d: 'Every workspace is sealed off at the database level, not only in application code.',
  },
  {
    t: 'Two-factor sign-in',
    d: 'Authenticator app codes, Google sign-in and recent-password checks for sensitive changes.',
  },
  {
    t: 'Encrypted visitor details',
    d: 'Contact details are encrypted at rest. Connections use TLS end to end.',
  },
  { t: 'Virus-scanned files', d: 'Every upload is scanned before an agent or a visitor can open it.' },
  {
    t: 'Consent and privacy requests',
    d: 'Consent mode for the widget, data export and erasure requests, and retention rules.',
  },
  { t: 'Audit log', d: 'A record of who changed what in your workspace, kept for your compliance reviews.' },
];

export function Security() {
  return (
    <section id="security" className="site-section" style={{ scrollMarginTop: 40 }}>
      <div
        className="site-glow"
        style={{ width: 600, height: 600, background: '#6a44c9', bottom: 0, left: -200, opacity: 0.2 }}
      />
      <div className="site-wrap grid grid-cols-1 gap-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Reveal>
          <Kicker>Security and privacy</Kicker>
          <h2 className="site-h2">
            Built for the conversations <em>you cannot afford to leak.</em>
          </h2>
          <p className="site-lead">
            Your visitors trust you with their questions, their contact details and their files. Talkivio is
            built so that trust is kept by design.
          </p>
        </Reveal>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {SECURITY.map((s, i) => (
            <Reveal key={s.t} delay={(i % 2) * 0.1} y={20}>
              <div className="site-card h-full p-6">
                <h3 className="m-0 text-[16px] font-normal">{s.t}</h3>
                <p className="mt-2 text-[14px] font-light leading-6 text-[var(--site-muted)]">{s.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Pricing() {
  const [cycle, setCycle] = useState<Cycle>('yearly');
  return (
    <section id="pricing" className="site-section" style={{ scrollMarginTop: 40 }}>
      <div
        className="site-glow"
        style={{
          width: 700,
          height: 500,
          background: '#05b0bd',
          top: 120,
          left: '50%',
          marginLeft: -350,
          opacity: 0.16,
        }}
      />
      <div className="site-wrap">
        <Reveal className="mx-auto max-w-3xl text-center">
          <Kicker>Pricing</Kicker>
          <h2 className="site-h2">
            Simple pricing, <em>per agent.</em>
          </h2>
          <p className="site-lead mx-auto">
            Every plan starts with a {TRIAL_DAYS}-day free trial. Add as many agents as you need and change
            plans at any time.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
            <div className="site-toggle" role="group" aria-label="Billing cycle">
              <button type="button" aria-pressed={cycle === 'monthly'} onClick={() => setCycle('monthly')}>
                Monthly
              </button>
              <button type="button" aria-pressed={cycle === 'yearly'} onClick={() => setCycle('yearly')}>
                Yearly
              </button>
            </div>
            <span className="site-micro text-[var(--site-teal)]">Save up to 20% yearly</span>
          </div>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {PLANS.map((p, i) => {
            const price = cycle === 'yearly' ? p.yearly : p.monthly;
            return (
              <Reveal key={p.id} delay={i * 0.1}>
                <div
                  className="site-card flex h-full flex-col p-8"
                  style={
                    p.popular
                      ? {
                          borderColor: 'rgba(55,229,231,0.55)',
                          boxShadow: '0 30px 90px -40px rgba(55,229,231,0.55)',
                        }
                      : undefined
                  }
                >
                  <div className="flex items-center justify-between">
                    <h3 className="m-0 text-[20px] font-normal">{p.name}</h3>
                    {p.popular && (
                      <span className="site-micro rounded-full bg-[var(--site-teal)] px-3 py-1 text-[10px] text-[var(--site-on-accent)]">
                        Most popular
                      </span>
                    )}
                  </div>
                  <p className="mt-3 min-h-[48px] text-[14.5px] font-light leading-6 text-[var(--site-muted)]">
                    {p.blurb}
                  </p>
                  <div className="mt-6 flex items-end gap-2">
                    <span className="text-[52px] font-extralight leading-none">{usd(price)}</span>
                    <span className="pb-1.5 text-[13.5px] font-light leading-5 text-[var(--site-muted)]">
                      per agent
                      <br />
                      per month
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] font-light text-[var(--site-subtle)]">
                    {cycle === 'yearly' ? `${usd(price * 12)} per agent, billed yearly` : 'Billed monthly'}
                  </p>
                  <Link
                    href={`/signup?plan=${p.id}&cycle=${cycle}`}
                    className={p.popular ? 'site-cta mt-7 justify-center' : 'site-ghost mt-7 justify-center'}
                  >
                    Start {TRIAL_DAYS}-day free trial
                  </Link>
                  <div className="mt-8 border-t border-[var(--site-line)] pt-6">
                    {p.includes && <p className="site-micro mb-4 text-[var(--site-subtle)]">{p.includes}</p>}
                    <ul className="m-0 space-y-3 p-0">
                      {p.features.map((f) => (
                        <li
                          key={f}
                          className="flex list-none gap-3 text-[14.5px] font-light leading-6 text-[var(--site-muted)]"
                        >
                          <Check />
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
        <p className="mx-auto mt-10 max-w-3xl text-center text-[13px] font-light leading-6 text-[var(--site-subtle)]">
          Prices in US dollars, excluding applicable taxes. A credit or debit card is required to start the
          trial. We email you {TRIAL_REMINDER_DAYS} days before it ends. Unless you cancel before the trial
          ends, your card is charged automatically for the plan you chose and then at the start of every
          billing period until you cancel. Cancel any time in Settings. Payments are non-refundable; see the{' '}
          <Link href="/legal/refund-policy" className="underline underline-offset-2">
            Refund Policy
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

/** An FAQ answer with its named phrase (if any) as a link. */
function Answer({ text, link }: { text: string; link?: { text: string; href: string } }) {
  if (!link || !text.includes(link.text)) return <>{text}</>;
  const [before, after] = text.split(link.text);
  return (
    <>
      {before}
      <Link href={link.href} className="text-[var(--site-teal)] underline underline-offset-2">
        {link.text}
      </Link>
      {after}
    </>
  );
}

export function Faq() {
  return (
    <section id="faq" className="site-section site-faq" style={{ scrollMarginTop: 40 }}>
      <div className="site-wrap grid grid-cols-1 gap-14 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
        <Reveal>
          <Kicker>FAQ</Kicker>
          <h2 className="site-h2">
            Questions, <em>answered.</em>
          </h2>
          <p className="site-lead">
            Something else? Write to{' '}
            <a
              href={`mailto:${COMPANY.supportEmail}`}
              className="text-[var(--site-teal)] underline underline-offset-2"
            >
              {COMPANY.supportEmail}
            </a>
            .
          </p>
        </Reveal>
        <div className="border-t border-[var(--site-line)]">
          {FAQS.map((f) => (
            <details key={f.q} className="border-b border-[var(--site-line)]">
              <summary className="flex min-h-[64px] cursor-pointer items-center justify-between gap-4 py-5 text-[16px] font-normal sm:gap-6 sm:py-6 sm:text-[17px]">
                {f.q}
                <span
                  className="site-faq-icon flex h-8 w-8 flex-none items-center justify-center rounded-full border border-[var(--site-line)] text-[var(--site-teal)] transition-transform duration-300"
                  aria-hidden="true"
                >
                  +
                </span>
              </summary>
              <div className="pb-6 pr-2 text-[15px] font-light leading-7 text-[var(--site-muted)] sm:pr-12">
                <Answer text={f.a} link={f.link} />
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FinalCta({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="site-section">
      <Reveal>
        <div className="site-wrap site-card relative overflow-hidden px-6 py-16 text-center sm:px-16 sm:py-20">
          <div
            className="site-glow"
            style={{
              width: 520,
              height: 320,
              background: '#37e5e7',
              top: -160,
              left: '50%',
              marginLeft: -260,
              opacity: 0.35,
            }}
          />
          <div
            className="site-glow"
            style={{
              width: 420,
              height: 320,
              background: '#6a44c9',
              bottom: -200,
              right: -80,
              opacity: 0.35,
            }}
          />
          <h2 className="site-h2 relative">
            Your next customer is <em>on your website now.</em>
          </h2>
          <p className="site-lead relative mx-auto">
            Start the conversation. {TRIAL_DAYS} days free, cancel any time.
          </p>
          <div className="relative mt-10 flex flex-wrap items-center justify-center gap-4">
            {signedIn ? (
              <Link href="/inbox" className="site-cta">
                Open dashboard
              </Link>
            ) : (
              <>
                <Link href="/signup?plan=team" className="site-cta">
                  Start {TRIAL_DAYS}-day free trial
                </Link>
                <Link href="/login" className="site-ghost">
                  Sign in
                </Link>
              </>
            )}
          </div>
        </div>
      </Reveal>
    </section>
  );
}
