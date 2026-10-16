'use client';
/*
  TALKIVIO hero, built on the Solis artboard.

  A fixed 1440x810 artboard scaled to the window width, a full-bleed backdrop on its own cover scale, a
  per-character headline cascade on the source file's clock, and choreography taken from the motion prototype.

  WHAT CHANGED FROM SOLIS

  The product is a live chat, not a ring: the backdrop is a lit glass chat bubble instead of molten gold footage,
  a still (Magnific, Seedream 5 Pro) animated into a seamless 10 s loop (Runway, the still as first and last frame):
  the bubble's three dots type, mist rises, light drifts. A slow push-in settles it, as the cut did in the source.
  The finish selector became the widget colour, which is a real setting in the product. The spec strip states numbers the product can back:
  the snippet install, the widget's languages and the trial.

  LAYERS. Scene covers, UI contains: sharing one scale puts the backdrop and the interface at different sizes on
  any window that is not 16:9.
*/
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useSession } from '@/stores/session';
import { SiteLogo } from './mark';
import { Particles } from './particles';
import { SiteThemeToggle } from './theme-switch';
import { DesktopAppLinks } from './desktop-app-links';
import { TRIAL_DAYS } from './site-config';

const STAGE_W = 1440;
/** The loop's first and last frame: the poster, and the page's first large paint. */
const HERO_STILL = '/site/hero-1440.webp';
const STAGE_H = 810;

/* The push-in runs this long and then holds, so the composition settles instead of looping. */
const SETTLE_S = 7.9;
/* The copy arrives once the scene has resolved, as in the source. */
const CUT_AT = 1.1;

const px = (n: number) => `${n}px`;
const box = (x: number, y: number, w?: number, h?: number): CSSProperties => ({
  position: 'absolute',
  left: px(x),
  top: px(y),
  ...(w !== undefined ? { width: px(w) } : null),
  ...(h !== undefined ? { height: px(h) } : null),
});

/* Four lines. 15..22 is "answered", the emphasis; 14 is the newline after "visitor,". */
const HEADLINE = 'Every visitor,\nanswered\nin real\ntime.';
const ITALIC_FROM = 15;
const ITALIC_TO = 22;

/* The stagger from the source file: 39ms through a word, longer at the breaks. */
const step = (i: number) => {
  const t = [
    0, 39, 78, 117, 156, 195, 234, 273, 312, 351, 429, 468, 507, 546, 585, 624, 663, 702, 741, 780, 819, 858,
    897, 936, 975, 1014, 1053, 1092, 1111, 1131, 1150, 1170, 1189, 1248, 1326,
  ];
  return (t[i] ?? i * 39) / 1000;
};

const NAV = [
  { label: 'Product', href: '#product', x: 520, from: -54 },
  { label: 'How it works', href: '#how', x: 612, from: -94 },
  { label: 'Pricing', href: '#pricing', x: 734, from: -124 },
  { label: 'Security', href: '#security', x: 824, from: -144 },
  { label: 'FAQ', href: '#faq', x: 922, from: -164 },
];

/* The widget colour, a real setting: it tints the typing dots and the card. */
const THEMES = [
  { name: 'Lagoon', color: '#37e5e7', swatch: 'linear-gradient(145deg,#b7fbfb,#37e5e7 52%,#05b0bd)' },
  { name: 'Violet', color: '#9b82f5', swatch: 'linear-gradient(145deg,#e4dcff,#9b82f5 52%,#6a44c9)' },
  { name: 'Ocean', color: '#05b0bd', swatch: 'linear-gradient(145deg,#8fe9ee,#05b0bd 52%,#07778a)' },
];

const RAIL = [
  { n: '01', label: 'Visitors', href: '#product' },
  { n: '02', label: 'Conversations', href: '#conversations' },
  { n: '03', label: 'Automation', href: '#features' },
  { n: '04', label: 'Security', href: '#security' },
];

const SPECS = [
  { v: '5 min', k: 'Sign-up to live' },
  { v: '9', k: 'Widget languages' },
  { v: `${TRIAL_DAYS} days`, k: 'Free trial' },
];

export function Hero() {
  const reduced = useReducedMotion() ?? false;
  const [scale, setScale] = useState(1);
  const [cover, setCover] = useState(1);
  const [cut, setCut] = useState(false);
  const [run, setRun] = useState(0);
  const [theme, setTheme] = useState(0);
  const [narrow, setNarrow] = useState(false);
  const [measured, setMeasured] = useState(false);
  const signedIn = useSession((s) => s.status === 'ready' && !!s.me);
  const load = useSession((s) => s.load);
  const status = useSession((s) => s.status);
  const frame = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Only a signed-in browser carries the CSRF cookie, so visitors never trigger a session lookup (and its 401).
    if (status === 'loading' && document.cookie.split('; ').some((c) => c.startsWith('rd_csrf=')))
      void load();
  }, [status, load]);

  useLayoutEffect(() => {
    const fit = () => {
      // Width-locked: the interface is exactly as wide as the window. The backdrop keeps its own cover scale.
      // clientWidth, not innerWidth: a classic scrollbar would otherwise push the right edge out of view.
      const w = document.documentElement.clientWidth;
      setScale(w / STAGE_W);
      setCover(Math.max(w / STAGE_W, window.innerHeight / STAGE_H));
      // Phones and tablets get the column layout: below ~1100 px the artboard would shrink the copy and menu
      // under a readable, tappable size. Same query as the CSS that shows one of the two layouts.
      setNarrow(!window.matchMedia('(min-width: 1100px)').matches);
      setMeasured(true);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    if (reduced) {
      setCut(true);
      return;
    }
    setCut(false);
    const a = setTimeout(() => setCut(true), CUT_AT * 1000);
    return () => clearTimeout(a);
  }, [run, reduced]);

  const slow = { duration: reduced ? 0 : 1.25, ease: [0.4, 0, 0.2, 1] as const };
  const back = { duration: reduced ? 0 : 0.4, ease: [0.68, -0.55, 0.27, 1.55] as const };
  const rise = (d: number) => ({ ...slow, delay: cut && !reduced ? d : 0 });
  const accent = THEMES[theme]!.color;
  const trialHref = '/signup?plan=team';

  // Both layouts are in the server HTML and CSS shows one (.site-hero-col below 1100 px, .site-hero-art above), so a
  // phone paints its own layout at once instead of the artboard first. Only the visible one may start the video.
  const backdrop = (column: boolean) => (
    <>
      <HeroScene narrow={narrow} video={measured && narrow === column} reduced={reduced} run={run} />
      {/* Particles are drawn in stage coordinates, so only on the artboard layout. */}
      {!column && !reduced && measured && !narrow && <Particles color={accent} count={40} />}
      <div className="site-vignette" style={{ position: 'absolute', inset: 0 }} />
      <div className="site-grain" style={{ position: 'absolute', inset: 0, opacity: 0.5 }} />
    </>
  );

  const letters = [...HEADLINE];
  return (
    <>
      <div className="site-hero-col">
        <MobileHero
          backdrop={backdrop(true)}
          signedIn={signedIn}
          trialHref={trialHref}
          cut={cut}
          reduced={reduced}
        />
      </div>
      <div className="site-hero-art">
        <div
          ref={frame}
          className="site-dark-scope relative w-full overflow-hidden"
          style={{ height: `max(calc(100vw * ${STAGE_H} / ${STAGE_W}), 100vh)` }}
        >
          {/* ---- scene: the settled backdrop. Covers. ---- */}
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: px(STAGE_W),
              height: px(STAGE_H),
              transform: `translate(-50%, -50%) scale(${cover})`,
              zIndex: 1,
            }}
          >
            {backdrop(false)}
          </div>

          {/* ---- UI artboard. Contains. ---- */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: px(STAGE_W),
              height: px(STAGE_H),
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              zIndex: 2,
            }}
            key={run}
          >
            {/* ---- nav: items fall from staggered heights over one duration ---- */}
            <nav aria-label="Main" style={box(40, 30, 1360, 28)}>
              <motion.div
                initial={{ y: reduced ? 0 : -92 }}
                animate={{ y: 0 }}
                transition={slow}
                style={{ position: 'absolute', left: 0, top: 4 }}
              >
                <Link href="/" className="flex items-center gap-[9px]" aria-label="Talkivio home">
                  <SiteLogo small />
                </Link>
              </motion.div>

              {NAV.map((n) => (
                <motion.a
                  key={n.label}
                  href={n.href}
                  initial={{ y: reduced ? 0 : n.from - 36 }}
                  animate={{ y: 0 }}
                  transition={slow}
                  className="site-navlink"
                  style={{
                    ...box(n.x - 40, 7),
                    fontSize: 13,
                    lineHeight: '14px',
                    fontWeight: 300,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {n.label}
                </motion.a>
              ))}

              <motion.div
                initial={{ y: reduced ? 0 : -92 }}
                animate={{ y: 0 }}
                transition={slow}
                style={{
                  ...box(1080, -2),
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 18,
                  height: 32,
                  width: 320,
                  whiteSpace: 'nowrap',
                }}
              >
                <SiteThemeToggle />
                {signedIn ? (
                  <Link href="/inbox" className="site-pill-outline site-micro">
                    Open dashboard
                  </Link>
                ) : (
                  <>
                    <Link href="/login" className="site-navlink" style={{ fontSize: 13, fontWeight: 300 }}>
                      Sign in
                    </Link>
                    <Link href={trialHref} className="site-pill-outline site-micro">
                      Start free trial
                    </Link>
                  </>
                )}
              </motion.div>
            </nav>

            {/* ---- eyebrow ---- */}
            <motion.div
              initial={{ opacity: 0, x: -24 }}
              animate={cut ? { opacity: 1, x: 0 } : { opacity: 0, x: -24 }}
              transition={rise(0.1)}
              style={{ ...box(42, 150), display: 'flex', alignItems: 'center', gap: 12 }}
            >
              <span style={{ width: 26, height: 1, background: 'var(--site-teal)' }} />
              <span className="site-micro" style={{ color: 'rgba(122,240,242,0.92)' }}>
                Live chat, done properly
              </span>
            </motion.div>

            {/* ---- headline: one span per character, on the file's own clock ---- */}
            <div style={{ ...box(38, 182, 660, 320) }}>
              <h1 className="site-h1">
                {/* The words as plain text for search engines and screen readers; the letters below only animate. */}
                <span className="sr-only">Every visitor, answered in real time.</span>
                {letters.map((ch, i) => {
                  if (ch === '\n') return <br key={i} />;
                  const emph = i >= ITALIC_FROM && i <= ITALIC_TO;
                  return (
                    <motion.span
                      key={i}
                      aria-hidden
                      className={emph ? 'site-emph' : undefined}
                      initial={{ opacity: 0, y: 42 }}
                      animate={cut ? { opacity: 1, y: 0 } : { opacity: 0, y: 42 }}
                      transition={{ ...back, delay: cut && !reduced ? step(i) : 0 }}
                      style={{
                        display: 'inline-block',
                        whiteSpace: 'pre',
                        ...(emph ? { fontSize: 72, fontWeight: 400, letterSpacing: '0.004em' } : null),
                      }}
                    >
                      {emph ? ch : ch.toUpperCase()}
                    </motion.span>
                  );
                })}
              </h1>
            </div>

            {/* ---- sub-copy ---- */}
            <motion.p
              initial={{ opacity: 0, y: 22 }}
              animate={cut ? { opacity: 1, y: 0 } : { opacity: 0, y: 22 }}
              transition={rise(0.9)}
              style={{
                ...box(42, 510, 380),
                margin: 0,
                fontSize: 15.5,
                lineHeight: '25px',
                fontWeight: 300,
                color: 'rgba(238,246,247,0.78)',
              }}
            >
              See who is on your website right now, where they are and what they are reading, then start the
              conversation in one click.
            </motion.p>

            {/* ---- trial + widget colour ---- */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={cut ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
              transition={rise(1.05)}
              style={{ ...box(42, 604), display: 'flex', alignItems: 'center', gap: 26 }}
            >
              <Link href={trialHref} className="site-cta">
                Start {TRIAL_DAYS}-day free trial
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                  <path
                    d="M2 11L11 2M11 2H4.5M11 2v6.5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </Link>

              <div
                role="radiogroup"
                aria-label="Widget colour"
                style={{ display: 'flex', alignItems: 'center', gap: 12 }}
              >
                {THEMES.map((th, i) => (
                  <button
                    key={th.name}
                    type="button"
                    role="radio"
                    aria-checked={i === theme}
                    onClick={() => setTheme(i)}
                    aria-label={th.name}
                    style={{
                      width: 26,
                      height: 26,
                      padding: 0,
                      borderRadius: '50%',
                      background: th.swatch,
                      border: 0,
                      outline: i === theme ? '1px solid rgba(122,240,242,0.95)' : '1px solid transparent',
                      outlineOffset: 3,
                      cursor: 'pointer',
                    }}
                  />
                ))}
                <span
                  className="site-micro"
                  style={{
                    color: 'rgba(238,246,247,0.66)',
                    marginLeft: 12,
                    minWidth: 92,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {THEMES[theme]!.name}
                </span>
              </div>
            </motion.div>

            {/* ---- desktop app ---- */}
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={cut ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
              transition={rise(1.15)}
              style={{ ...box(42, 663) }}
            >
              <DesktopAppLinks />
            </motion.div>

            {/* ---- spec strip ---- */}
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={cut ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
              transition={rise(1.25)}
              style={{ ...box(42, 714, 470) }}
            >
              <div className="site-hair" style={{ width: '100%' }} />
              <div style={{ display: 'flex', marginTop: 18 }}>
                {SPECS.map((s, i) => (
                  <div
                    key={s.k}
                    style={{
                      flex: 1,
                      paddingLeft: i === 0 ? 0 : 22,
                      borderLeft: i === 0 ? 0 : '1px solid rgba(55,229,231,0.2)',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 22,
                        fontWeight: 300,
                        color: 'var(--site-paper)',
                        lineHeight: '26px',
                      }}
                    >
                      {s.v}
                    </div>
                    <div className="site-micro" style={{ color: 'rgba(238,246,247,0.55)', marginTop: 7 }}>
                      {s.k}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>

            {/* ---- index rail: numbers with the section they open ---- */}
            <div style={{ ...box(1180, 210, 236, 344), overflow: 'hidden' }}>
              <motion.div
                initial={{ x: 120, opacity: 0 }}
                animate={cut ? { x: 0, opacity: 1 } : { x: 120, opacity: 0 }}
                transition={rise(0.75)}
                style={{ position: 'absolute', inset: 0 }}
              >
                {RAIL.map((r, i) => (
                  <a
                    key={r.n}
                    href={r.href}
                    className="site-rail"
                    style={{
                      position: 'absolute',
                      right: 0,
                      top: i * 88,
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'flex-end',
                      gap: 14,
                      opacity: i === 0 ? 1 : 0.62,
                      textShadow: '0 1px 14px rgba(5,7,10,0.9)',
                    }}
                  >
                    <span className="site-micro" style={{ color: 'rgba(238,246,247,0.78)' }}>
                      {r.label}
                    </span>
                    <span
                      style={{
                        fontSize: i === 0 ? 46 : 30,
                        lineHeight: '1',
                        fontWeight: 200,
                        color: i === 0 ? 'var(--site-teal)' : 'var(--site-paper)',
                        minWidth: 62,
                        textAlign: 'right',
                      }}
                    >
                      {r.n}
                    </span>
                  </a>
                ))}
                <div
                  style={{
                    position: 'absolute',
                    right: -2,
                    top: 4,
                    width: 1,
                    height: 42,
                    background: 'var(--site-teal)',
                  }}
                />
              </motion.div>
            </div>

            {/* ---- stat card: swept corner, rising into place ---- */}
            <div style={{ ...box(1006, 566, 434, 244), overflow: 'hidden' }}>
              <motion.div
                initial={{ y: 250 }}
                animate={cut ? { y: 0 } : { y: 250 }}
                transition={rise(1.4)}
                style={{ position: 'absolute', inset: 0 }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: 60,
                    top: 58,
                    width: 374,
                    height: 186,
                    background: 'rgba(238,246,247,0.96)',
                    borderTopLeftRadius: 96,
                  }}
                />
                <div style={{ position: 'absolute', left: 92, top: 36 }}>
                  <CardBubble color={accent} reduced={reduced} />
                </div>
                <div style={{ position: 'absolute', left: 262, top: 104, width: 160 }}>
                  <div style={{ fontSize: 30, lineHeight: '34px', fontWeight: 300, color: '#06232a' }}>
                    1 click
                  </div>
                  <div
                    className="site-micro"
                    style={{
                      color: 'rgba(6,35,42,0.66)',
                      marginTop: 8,
                      letterSpacing: '0.2em',
                      lineHeight: '17px',
                    }}
                  >
                    Visitor to conversation
                  </div>
                </div>
              </motion.div>
            </div>
          </div>

          <button type="button" onClick={() => setRun((r) => r + 1)} className="site-replay">
            replay
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * The backdrop: one <video> element whose poster is the still frame, so the still paints at once (preloaded with
 * high priority) and is the page's Largest Contentful Paint. Once the page has loaded, the visible layout attaches
 * the loop to that same element and it plays: the loop starts and ends on the still, so the hand-over is invisible,
 * and no second element can replace the still as the largest paint. A phone gets only the 720p file; reduced motion
 * and browsers asking to save data keep the still.
 */
function HeroScene({
  narrow,
  video,
  reduced,
  run,
}: {
  narrow: boolean;
  /** This layout is the one on screen and has been measured: it may start the loop. */
  video: boolean;
  reduced: boolean;
  run: number;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (conn?.saveData) return;
    const go = () => setLoaded(true);
    if (document.readyState === 'complete') {
      const t = window.setTimeout(go, 150);
      return () => window.clearTimeout(t);
    }
    window.addEventListener('load', go, { once: true });
    return () => window.removeEventListener('load', go);
  }, []);
  const play = !reduced && video && loaded;
  useEffect(() => {
    const v = ref.current;
    if (!v || !play) return;
    // Sources added after the element exists are only picked up by load().
    v.load();
    void v.play().catch(() => undefined);
  }, [play, narrow, run]);

  return (
    <motion.div
      key={`scene-${run}`}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, transformOrigin: '64% 52%' }}
      initial={reduced ? false : { scale: 1.08 }}
      animate={{ scale: 1 }}
      transition={{ duration: reduced ? 0 : SETTLE_S, ease: [0.16, 1, 0.3, 1] }}
    >
      <video
        ref={ref}
        poster={HERO_STILL}
        muted
        loop
        playsInline
        autoPlay={play}
        preload={play ? 'auto' : 'none'}
        // Browsers may pause a muted background video (power saving, a covered tab); resume it while it is shown.
        onPause={(e) => {
          const v = e.currentTarget;
          if (play && document.visibilityState === 'visible')
            window.setTimeout(() => void v.play().catch(() => undefined), 300);
        }}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: 'var(--hero-focus, 50% 50%)',
        }}
      >
        {play && (
          <>
            <source src={narrow ? '/site/hero-720.webm' : '/site/hero.webm'} type="video/webm" />
            <source src={narrow ? '/site/hero-720.mp4' : '/site/hero.mp4'} type="video/mp4" />
          </>
        )}
      </video>
    </motion.div>
  );
}

/** Phones and tablets: the artboard would scale the copy below readable size, so the same story is told in a column. */
function MobileHero({
  backdrop,
  signedIn,
  trialHref,
  cut,
  reduced,
}: {
  backdrop: React.ReactNode;
  signedIn: boolean;
  trialHref: string;
  cut: boolean;
  reduced: boolean;
}) {
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);
  const fade = (d: number) => ({
    initial: { opacity: 0, y: 18 },
    animate: cut ? { opacity: 1, y: 0 } : { opacity: 0, y: 18 },
    transition: {
      duration: reduced ? 0 : 0.9,
      delay: cut && !reduced ? d : 0,
      ease: [0.4, 0, 0.2, 1] as const,
    },
  });
  return (
    <div className="site-dark-scope relative min-h-[100svh] w-full overflow-hidden bg-[#05070a]">
      {/* The scene fills the top of a tall screen so the whole bubble shows above the copy (it sits right of centre). */}
      <div
        className="absolute inset-x-0 top-0 h-[62svh] overflow-hidden sm:h-[66svh]"
        style={{ '--hero-focus': '66% 50%' } as CSSProperties}
      >
        {backdrop}
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-b from-transparent to-[#05070a]" />
      </div>
      <div className="absolute inset-0 bg-gradient-to-b from-[#05070a99] via-transparent to-transparent" />
      <div className="relative z-[2] flex min-h-[100svh] flex-col px-5 pb-8 pt-4 sm:px-10 sm:pb-14 sm:pt-6">
        <nav aria-label="Main" className="relative flex items-center justify-between">
          <Link href="/" className="site-tap flex items-center gap-2" aria-label="Talkivio home">
            <SiteLogo small />
          </Link>
          <div className="flex items-center gap-1 sm:gap-3">
            <SiteThemeToggle />
            {signedIn ? (
              <Link href="/inbox" className="site-pill-outline site-micro">
                Open dashboard
              </Link>
            ) : (
              <Link href="/login" className="site-navlink site-tap px-2 text-sm">
                Sign in
              </Link>
            )}
            <button
              type="button"
              className="site-menu-btn"
              aria-expanded={menu}
              aria-controls="site-mobile-menu"
              onClick={() => setMenu((m) => !m)}
            >
              <span className="sr-only">{menu ? 'Close menu' : 'Open menu'}</span>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                {menu ? (
                  <path
                    d="M5 5l10 10M15 5L5 15"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                ) : (
                  <path
                    d="M3 6h14M3 10h14M3 14h14"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                )}
              </svg>
            </button>
          </div>
          {menu && (
            <div id="site-mobile-menu" className="site-menu">
              <ul className="m-0 p-0">
                {NAV.map((n) => (
                  <li key={n.href} className="list-none">
                    <a href={n.href} onClick={() => setMenu(false)}>
                      {n.label}
                    </a>
                  </li>
                ))}
              </ul>
              <Link
                href={trialHref}
                className="site-cta mt-4 w-full justify-center"
                onClick={() => setMenu(false)}
              >
                Start {TRIAL_DAYS}-day free trial
              </Link>
            </div>
          )}
        </nav>
        <div className="mt-auto max-w-[640px]">
          <motion.p {...fade(0)} className="site-micro mb-4" style={{ color: 'rgba(122,240,242,0.92)' }}>
            Live chat, done properly
          </motion.p>
          <motion.h1 {...fade(0.1)} className="site-h1 site-h1-m">
            EVERY VISITOR, <span className="site-emph">answered</span> IN REAL TIME.
          </motion.h1>
          <motion.p
            {...fade(0.3)}
            className="mt-4 text-[15px] font-light leading-6 sm:mt-6 sm:text-[17px] sm:leading-7"
            style={{ color: 'rgba(238,246,247,0.8)' }}
          >
            See who is on your website right now, where they are and what they are reading, then start the
            conversation in one click.
          </motion.p>
          <motion.div {...fade(0.45)} className="mt-6">
            <Link href={trialHref} className="site-cta">
              Start {TRIAL_DAYS}-day free trial
            </Link>
          </motion.div>
          <motion.div {...fade(0.52)} className="mt-4">
            <DesktopAppLinks />
          </motion.div>
          <motion.dl
            {...fade(0.6)}
            className="mt-8 grid grid-cols-3 gap-3 border-t border-[rgba(55,229,231,0.25)] pt-4 sm:mt-10 sm:gap-6 sm:pt-6"
          >
            {SPECS.map((s) => (
              <div key={s.k}>
                <dt className="site-micro order-2 mt-1" style={{ color: 'rgba(238,246,247,0.55)' }}>
                  {s.k}
                </dt>
                <dd className="text-lg font-light sm:text-2xl" style={{ color: 'var(--site-paper)' }}>
                  {s.v}
                </dd>
              </div>
            ))}
          </motion.dl>
        </div>
      </div>
    </div>
  );
}

/** The card's bubble: the widget colour, with three dots that type. */
function CardBubble({ color, reduced }: { color: string; reduced: boolean }) {
  return (
    <div
      style={{
        position: 'relative',
        width: 150,
        height: 120,
        borderRadius: '46% 46% 46% 46% / 50% 50% 46% 46%',
        background: `radial-gradient(120% 120% at 30% 25%, #ffffff 0%, ${color} 38%, #6a44c9 100%)`,
        boxShadow: `0 18px 34px -14px ${color}, inset 0 2px 10px rgba(255,255,255,0.55)`,
        filter: 'drop-shadow(0 16px 26px rgba(0,0,0,0.35))',
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 18,
          bottom: -16,
          width: 34,
          height: 30,
          background: color,
          clipPath: 'polygon(0 100%, 30% 0, 100% 10%)',
          opacity: 0.95,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
        }}
      >
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            aria-hidden
            animate={reduced ? { y: 0, opacity: 1 } : { y: [0, -5, 0], opacity: [0.6, 1, 0.6] }}
            transition={
              reduced
                ? { duration: 0 }
                : { duration: 1.1, repeat: Infinity, delay: i * 0.16, ease: 'easeInOut' }
            }
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: '#ffffff',
              boxShadow: '0 0 10px rgba(255,255,255,0.9)',
            }}
          />
        ))}
      </div>
    </div>
  );
}
