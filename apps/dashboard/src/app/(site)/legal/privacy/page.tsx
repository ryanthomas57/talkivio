import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalDoc, Mail, type LegalSection } from '@/components/site/legal';
import { COMPANY } from '@/components/site/site-config';

export const metadata: Metadata = {
  title: { absolute: 'Privacy Policy | Talkivio' },
  description: `How ${COMPANY.legalName} collects, uses and protects personal information in ${COMPANY.product}.`,
};

const C = COMPANY;

const sections: LegalSection[] = [
  {
    id: 'scope',
    title: 'Who we are and what this policy covers',
    body: (
      <>
        <p>
          {C.product} is a live chat and visitor tracking service provided by {C.legalName} (&quot;
          <strong>we</strong>&quot;, &quot;<strong>us</strong>&quot; or &quot;<strong>our</strong>&quot;).
          This Privacy Policy explains how we handle personal information about:
        </p>
        <ul>
          <li>
            <strong>Customers and Agents</strong>: the businesses that subscribe to {C.product} and the people
            who sign in to its dashboard;
          </li>
          <li>
            <strong>Website visitors</strong>: people who visit our own website or contact us.
          </li>
        </ul>
        <p>
          <strong>End Users of our customers&apos; websites.</strong> When you chat with a business through a{' '}
          {C.product} widget on its website, that business decides what is collected and why, and is
          responsible for your information as the controller. We process that information only on its behalf
          and on its instructions, as its processor or service provider. Please read the privacy notice of the
          website you visited, and send any request about your information to that business. If you contact
          us, we will forward your request to it where we can identify it.
        </p>
      </>
    ),
  },
  {
    id: 'collect',
    title: 'Information we collect',
    body: (
      <>
        <h3>Information you give us</h3>
        <ul>
          <li>
            Account details: name, email address, password (stored only as a secure hash), workspace name,
            role and preferences.
          </li>
          <li>
            Billing details: billing name and address, plan, number of Agents and invoices. Card numbers are
            entered directly into our payment processor&apos;s secure form; we receive and keep only a token,
            the card brand, the last four digits and the expiry date.
          </li>
          <li>
            Communications: messages you send to our support, billing or legal teams, and your feedback.
          </li>
          <li>Two-factor authentication settings, recovery codes (hashed) and trusted devices.</li>
        </ul>
        <h3>Information collected automatically</h3>
        <ul>
          <li>
            Log and device data: IP address, browser and operating system, device type, pages viewed, date and
            time, and referring page.
          </li>
          <li>
            Security data: sign-in events, sessions, approximate location derived from IP address, and audit
            records of changes in your workspace.
          </li>
          <li>Usage data: features used, settings changed and performance metrics.</li>
        </ul>
        <h3>Customer Data we process for our customers</h3>
        <p>
          On behalf of our customers, the Service processes chat messages and files, visitor names, email
          addresses, phone numbers and notes entered by visitors or Agents, visitor IP addresses, the network
          that owns each IP address, approximate location (country and city), browser, device, pages viewed
          and referrers. Our customers control this data, and our use of it is limited to providing the
          Service as described in our <Link href="/legal/terms">Terms of Use</Link>.
        </p>
      </>
    ),
  },
  {
    id: 'use',
    title: 'How we use information',
    body: (
      <>
        <p>We use personal information to:</p>
        <ul>
          <li>provide, operate, maintain and secure the Service, and authenticate users;</li>
          <li>
            process payments, manage subscriptions and free trials, and send invoices, receipts and trial
            reminders;
          </li>
          <li>
            send service messages such as email verification, invitations, password resets, security alerts
            and notices about changes;
          </li>
          <li>provide support and respond to requests;</li>
          <li>
            detect, investigate and prevent fraud, abuse, security incidents and violations of our Terms;
          </li>
          <li>
            understand how the Service is used and improve it, using aggregated or de-identified data where we
            can;
          </li>
          <li>
            comply with legal obligations, enforce our agreements, and establish, exercise or defend legal
            claims;
          </li>
          <li>send product news to customers, which you can unsubscribe from at any time.</li>
        </ul>
        <p>
          We do not use Customer Data to train models for anyone else, and we do not sell personal
          information.
        </p>
      </>
    ),
  },
  {
    id: 'legal-bases',
    title: 'Legal bases (EEA and UK)',
    body: (
      <p>
        Where the GDPR or UK GDPR applies, we rely on: performance of our contract with you (to provide the
        Service and process payments); our legitimate interests (to secure and improve the Service, prevent
        fraud, and communicate with customers about the Service, balanced against your rights); compliance
        with legal obligations (for example tax and accounting records); and your consent where we ask for it,
        which you may withdraw at any time.
      </p>
    ),
  },
  {
    id: 'cookies',
    title: 'Cookies and similar technologies',
    body: (
      <>
        <p>
          The dashboard uses strictly necessary cookies to keep you signed in, protect against cross-site
          request forgery and remember security choices such as trusted devices. We also use local browser
          storage for interface preferences. We do not use third-party advertising cookies on our website or
          dashboard.
        </p>
        <p>
          The chat widget that our customers install uses browser storage to recognise a returning visitor and
          keep a conversation open across pages. Customers can run the widget in consent mode, so that nothing
          is stored until the visitor agrees, and are responsible for obtaining any consent their
          visitors&apos; laws require.
        </p>
      </>
    ),
  },
  {
    id: 'sharing',
    title: 'How we share information',
    body: (
      <>
        <p>We share personal information only as follows:</p>
        <ul>
          <li>
            <strong>Service providers</strong> who process it for us under contract and confidentiality
            obligations, for hosting and infrastructure, email delivery, file storage, and payment processing
            (Converge, operated by Elavon, Inc.).
          </li>
          <li>
            <strong>Our customers</strong>: information about Agents is visible to the administrators of their
            workspace, and Customer Data is available to the customer that controls it.
          </li>
          <li>
            <strong>Integrations you enable</strong>, such as webhooks and API clients configured in your
            workspace.
          </li>
          <li>
            <strong>Legal and safety</strong>: where we believe in good faith that disclosure is required by
            law, regulation, legal process or a government request, or is necessary to protect the rights,
            property or safety of {C.legalName}, our customers, users or the public.
          </li>
          <li>
            <strong>Business transfers</strong>: in connection with a merger, acquisition, financing,
            reorganisation or sale of all or part of our business, subject to this Privacy Policy.
          </li>
          <li>
            <strong>With your direction or consent.</strong>
          </li>
        </ul>
        <p>
          We do not sell personal information, and we do not share it for cross-context behavioural
          advertising, as those terms are defined under California law.
        </p>
      </>
    ),
  },
  {
    id: 'transfers',
    title: 'International transfers',
    body: (
      <p>
        {C.legalName} is based in the United States, and we and our service providers may process information
        in the United States and other countries whose data protection laws may differ from yours. Where the
        law requires, we protect transfers with appropriate safeguards such as the European Commission&apos;s
        Standard Contractual Clauses and the UK International Data Transfer Addendum.
      </p>
    ),
  },
  {
    id: 'retention',
    title: 'Retention',
    body: (
      <p>
        We keep account information for as long as your account is active and for a reasonable period
        afterwards to comply with legal, tax and accounting obligations, resolve disputes and enforce our
        agreements. Customer Data is kept according to the retention settings each customer chooses and is
        deleted within 30 days after a subscription ends, unless the law requires us to keep it longer.
        Backups are overwritten on a rolling schedule. Security logs are kept for as long as needed to protect
        the Service.
      </p>
    ),
  },
  {
    id: 'security',
    title: 'Security',
    body: (
      <p>
        We use administrative, technical and physical safeguards designed to protect personal information,
        including encryption in transit, encryption of visitor contact details at rest, database-level
        isolation between workspaces, virus scanning of uploaded files, two-factor authentication, access
        controls and audit logging. No method of transmission or storage is completely secure, and we cannot
        guarantee absolute security. You are responsible for keeping your credentials safe.
      </p>
    ),
  },
  {
    id: 'rights',
    title: 'Your rights and choices',
    body: (
      <>
        <p>
          Depending on where you live, you may have the right to access, correct, delete or receive a copy of
          your personal information, to object to or restrict certain processing, to withdraw consent, and to
          complain to a data protection authority. Residents of California and other US states with privacy
          laws may have rights to know, delete and correct their personal information and to opt out of sale,
          sharing and targeted advertising (we do not sell or share personal information or use it for
          targeted advertising). We will not discriminate against you for exercising your rights.
        </p>
        <p>
          You can update most account information in the dashboard. To make a request, email{' '}
          <Mail to={C.privacyEmail} /> from the address on your account. We will verify your identity before
          acting, and may ask for more information to do so. You may use an authorised agent where the law
          allows, and we may require proof of the agent&apos;s authority. If we decline your request, you may
          appeal by replying to our decision.
        </p>
        <p>
          If your information is Customer Data (for example, you chatted with a business that uses {C.product}
          ), please contact that business directly, as it controls your information.
        </p>
      </>
    ),
  },
  {
    id: 'children',
    title: 'Children',
    body: (
      <p>
        The Service is intended for business use by adults and is not directed to children under 16. We do not
        knowingly collect personal information from children. If you believe a child has given us personal
        information, contact us and we will delete it.
      </p>
    ),
  },
  {
    id: 'changes',
    title: 'Changes to this policy',
    body: (
      <p>
        We may update this Privacy Policy from time to time. We will post the updated version on this page and
        update the &quot;Last updated&quot; date, and if the changes are material we will notify customers by
        email or in the Service before they take effect.
      </p>
    ),
  },
  {
    id: 'contact',
    title: 'Contact',
    body: (
      <p>
        {C.legalName}, operator of {C.product}. Privacy questions and requests: <Mail to={C.privacyEmail} />.
        Other legal matters: <Mail to={C.legalEmail} />.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalDoc
      kicker="Legal"
      title="Privacy Policy"
      intro={
        <p>
          This policy explains what personal information {C.legalName} collects through {C.product}, how we
          use and share it, and the choices and rights you have.
        </p>
      }
      sections={sections}
    />
  );
}
