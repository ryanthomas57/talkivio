import { TRIAL_DAYS, TRIAL_REMINDER_DAYS } from './site-config';

/**
 * The home page FAQ. Plain text, so the visible answers and the FAQPage structured data are always the same words;
 * `link` turns its phrase in the answer into a link on the page.
 */
export const FAQS: Array<{ q: string; a: string; link?: { text: string; href: string } }> = [
  {
    q: 'How does the free trial work?',
    a: `You get every feature of the plan you choose for ${TRIAL_DAYS} days. A credit or debit card is required to start. We remind you by email ${TRIAL_REMINDER_DAYS} days before the trial ends. If you do not cancel before the end of the trial, the card is charged automatically for your plan and number of agents.`,
  },
  {
    q: 'Can I cancel at any time?',
    a: 'Yes. Cancel in Settings, Billing, in a couple of clicks. Your plan stays active until the end of the period you have paid for and is not renewed after that.',
  },
  {
    q: 'Do you offer refunds?',
    a: 'No. Subscriptions are billed in advance and all payments are final, including partial periods and unused agents. Cancel before your trial ends to avoid any charge. The full terms are in our Refund Policy.',
    link: { text: 'Refund Policy', href: '/legal/refund-policy' },
  },
  {
    q: 'How is the price calculated?',
    a: 'Per agent, per month. An agent is any team member who can sign in to answer chats. Add or remove agents whenever you like; additions are charged for the rest of the current period.',
  },
  {
    q: 'Can I see a visitor’s IP address and network?',
    a: 'Yes. Each visitor shows an IP address and the network that owns it, such as a home internet provider, a mobile carrier or a hosting company. A hosting company or VPN provider is a good sign the visitor is hiding their real location.',
  },
  {
    q: 'Which websites does it work with?',
    a: 'Any website where you can add a script tag: WordPress, Shopify, Webflow, Wix, Squarespace or your own code. Single-page applications are supported too.',
  },
  {
    q: 'Which languages does the widget speak?',
    a: 'English, Arabic, Spanish, French, German, Portuguese, Italian, Dutch and Japanese. It follows the visitor’s browser language, or you can fix one.',
  },
  {
    q: 'Is my data safe?',
    a: 'Workspaces are isolated at the database level, visitor contact details are encrypted, uploads are virus scanned and sign-in supports two-factor authentication. Read the Privacy Policy for the details.',
    link: { text: 'Privacy Policy', href: '/legal/privacy' },
  },
];
