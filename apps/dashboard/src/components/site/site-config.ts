import { PLAN_CATALOG, type BillingCycle, type PlanId } from '@talkivio/contracts';

/**
 * Public website facts in one place: the company behind Talkivio, how to reach it, and the plans and prices that
 * the home page, the legal pages and checkout all quote. Change a value here and every page follows.
 */
export const COMPANY = {
  legalName: 'Desverso LLC',
  product: 'Talkivio',
  governingLaw: 'the State of Delaware, United States',
  arbitrationSeat: 'Wilmington, Delaware',
  supportEmail: 'support@talkivio.com',
  billingEmail: 'billing@talkivio.com',
  privacyEmail: 'privacy@talkivio.com',
  legalEmail: 'legal@talkivio.com',
  /** Date shown as "Last updated" on the legal pages. */
  legalUpdated: 'October 14, 2026',
} as const;

/**
 * The desktop app (desktop/): installers attached to the latest GitHub release under fixed names, so these links
 * always serve the newest version. `signed` turns off the "opening it the first time" help once the Mac build is
 * notarized and the Windows installer is code signed.
 */
const RELEASES = 'https://github.com/ryanthomas57/talkivio/releases/latest';
export const DESKTOP = {
  mac: `${RELEASES}/download/Talkivio-mac-universal.dmg`,
  windows: `${RELEASES}/download/Talkivio-win-x64.exe`,
  releaseNotes: RELEASES,
  macRequirement: 'macOS 13 Ventura or later, Apple silicon and Intel',
  windowsRequirement: 'Windows 10 or 11, 64-bit',
  signed: false,
} as const;

/** Trial length and reminder lead time come from the shared plan catalog, like the prices below. */
export { TRIAL_DAYS, TRIAL_REMINDER_DAYS } from '@talkivio/contracts';

export type { PlanId };
export type Cycle = BillingCycle;

export interface Plan {
  id: PlanId;
  name: string;
  /** USD per agent per month, billed monthly. */
  monthly: number;
  /** USD per agent per month, billed once a year (12 × this amount). */
  yearly: number;
  blurb: string;
  popular?: boolean;
  /** "Everything in …, plus" heading for the feature list. */
  includes?: string;
  features: string[];
}

/** Prices come from the plan catalog the API charges by; only the wording lives here. */
const price = (id: PlanId) => ({
  monthly: PLAN_CATALOG[id].monthlyCents / 100,
  yearly: PLAN_CATALOG[id].yearlyCents / 100,
});

export const PLANS: Plan[] = [
  {
    id: 'starter',
    name: PLAN_CATALOG.starter.name,
    ...price('starter'),
    blurb: 'For a small team answering chats on one website.',
    features: [
      'Chat widget for 1 website',
      'Real-time visitor list with location, IP and network',
      'Docked chat windows and a shared inbox',
      'Canned responses',
      'File sharing with virus scanning',
      'Offline messages by email and business hours',
      '60 days of chat history',
      'Visitor data export and erasure requests',
    ],
  },
  {
    id: 'team',
    name: PLAN_CATALOG.team.name,
    ...price('team'),
    popular: true,
    blurb: 'Routing, automation and reporting for growing support and sales teams.',
    includes: 'Everything in Starter, plus',
    features: [
      'Up to 5 websites',
      'Unlimited chat history',
      'Departments and smart routing',
      'Proactive chat triggers',
      'Agent and trigger analytics, CSV exports',
      'Custom visitor fields and tags',
    ],
  },
  {
    id: 'business',
    name: PLAN_CATALOG.business.name,
    ...price('business'),
    blurb: 'Supervision, integrations and compliance controls at scale.',
    includes: 'Everything in Team, plus',
    features: [
      'Unlimited websites',
      'Supervisor monitor and forced transfers',
      'Webhooks and REST API',
      'Verified visitor identity',
      'Data retention rules and audit log',
      'Priority email support',
    ],
  },
];

export const usd = (n: number) => `$${n % 1 === 0 ? n : n.toFixed(2)}`;
