import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalDoc, Mail, type LegalSection } from '@/components/site/legal';
import { pageMetadata } from '@/components/site/seo';
import { COMPANY, TRIAL_DAYS, TRIAL_REMINDER_DAYS } from '@/components/site/site-config';

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({
    title: 'Terms of Use | Talkivio',
    description: `The terms that govern your use of ${COMPANY.product}, a product of ${COMPANY.legalName}.`,
    path: '/legal/terms',
  });
}

const C = COMPANY;

const sections: LegalSection[] = [
  {
    id: 'acceptance',
    title: 'Acceptance of these Terms',
    body: (
      <>
        <p>
          These Terms of Use (the &quot;<strong>Terms</strong>&quot;) form a legally binding agreement between
          you and {C.legalName}, a Delaware limited liability company (&quot;<strong>{C.legalName}</strong>
          &quot;, &quot;<strong>we</strong>&quot;, &quot;<strong>us</strong>&quot; or &quot;
          <strong>our</strong>&quot;), and govern your access to and use of {C.product}, including the
          website, the dashboard, the chat widget, the application programming interfaces, the mobile and
          desktop experiences and all related software, content and services (together, the &quot;
          <strong>Service</strong>&quot;).
        </p>
        <p>
          By creating an account, starting a free trial, clicking to accept these Terms, installing the chat
          widget or otherwise using the Service, you agree to these Terms, our{' '}
          <Link href="/legal/privacy">Privacy Policy</Link> and our{' '}
          <Link href="/legal/refund-policy">Refund Policy</Link>, which are incorporated into these Terms by
          reference. If you do not agree, you must not use the Service.
        </p>
        <p>
          If you use the Service on behalf of a company or other organisation, you represent and warrant that
          you have the authority to bind that organisation to these Terms, and &quot;<strong>you</strong>
          &quot; and &quot;<strong>Customer</strong>&quot; refer to that organisation. You must be at least 18
          years old and able to form a binding contract to use the Service.
        </p>
        <p className="site-caps">
          Please read section 22 carefully. It requires disputes to be resolved by binding individual
          arbitration and waives your right to a jury trial and to take part in a class action.
        </p>
      </>
    ),
  },
  {
    id: 'business-use',
    title: 'Business use only',
    body: (
      <p>
        The Service is designed and offered solely for business and professional use. By subscribing, you
        represent and warrant that you are acquiring the Service for the purposes of your trade, business,
        craft or profession and not as a consumer. To the fullest extent permitted by law, consumer protection
        rights that apply only to consumers (including statutory cooling-off and withdrawal rights) do not
        apply to your subscription.
      </p>
    ),
  },
  {
    id: 'definitions',
    title: 'Definitions',
    body: (
      <ul>
        <li>
          <strong>Agent</strong> means each individual user account in your workspace that can sign in to the
          dashboard, whether or not that individual answers chats in a given period.
        </li>
        <li>
          <strong>Customer Data</strong> means the data you or your Agents submit to the Service, and the data
          the Service collects from End Users on your behalf, including chat messages, files, visitor details
          and notes.
        </li>
        <li>
          <strong>End User</strong> means a visitor to a website or application on which you install the chat
          widget.
        </li>
        <li>
          <strong>Subscription</strong> means your paid plan for the Service, including the plan tier, the
          number of Agents and the billing period (monthly or yearly).
        </li>
        <li>
          <strong>Workspace</strong> means the separate environment in the Service in which your Agents, sites
          and Customer Data are held.
        </li>
      </ul>
    ),
  },
  {
    id: 'service',
    title: 'The Service',
    body: (
      <>
        <p>
          Subject to these Terms and payment of all applicable fees, we grant you a limited, non-exclusive,
          non-transferable, non-sublicensable, revocable right during your Subscription to access and use the
          Service for your internal business purposes, within the limits of your plan.
        </p>
        <p>
          We continuously change and improve the Service. We may add, change, limit or remove features or
          functions at any time, with or without notice, and we are not obliged to continue providing any
          particular feature. Where a change materially reduces the core functionality of your paid plan, we
          will make reasonable efforts to notify you in advance. Features described as beta, preview, early
          access or similar are provided as they are, may be withdrawn at any time and are excluded from any
          commitments we make about the Service.
        </p>
        <p>
          Unless we have signed a separate written service level agreement with you, we do not guarantee any
          particular availability, uptime, response time or delivery time, and the figures we publish describe
          typical performance only.
        </p>
      </>
    ),
  },
  {
    id: 'accounts',
    title: 'Accounts and security',
    body: (
      <>
        <p>
          You must give accurate, current and complete information when you register and keep it up to date.
          You are responsible for all activity in your Workspace and under your Agents&apos; accounts, whether
          or not you authorised it, and for keeping passwords, authentication devices, API tokens and widget
          keys confidential. We strongly recommend that every Agent turns on two-factor authentication.
        </p>
        <p>
          You must notify us immediately at <Mail to={C.supportEmail} /> if you become aware of any
          unauthorised access to or use of your Workspace. We are not liable for any loss or damage arising
          from your failure to protect your credentials or to comply with this section.
        </p>
      </>
    ),
  },
  {
    id: 'trial',
    title: 'Free trial',
    body: (
      <>
        <p>
          We may offer a free trial of a paid plan for {TRIAL_DAYS} days, or another period we state when you
          sign up (the &quot;<strong>Trial</strong>&quot;). To start a Trial you must provide a valid credit
          or debit card and authorise us to charge it.{' '}
          <strong>
            When the Trial ends, your Subscription starts automatically and your card is charged the
            then-current fee for the plan, billing period and number of Agents you selected, unless you cancel
            before the Trial ends.
          </strong>
        </p>
        <p>
          We will send a reminder to the email address on your account at least {TRIAL_REMINDER_DAYS} days
          before the Trial ends, stating the date of the first charge, the amount and how to cancel. You can
          cancel at any time before the Trial ends in Settings, Billing, and you will not be charged. It is
          your responsibility to cancel in time; not reading or not receiving the reminder (for example
          because of spam filtering or an out-of-date email address) does not entitle you to a refund.
        </p>
        <p>
          Trials are limited to one per organisation, per payment card and per person. We may verify your card
          with a temporary authorisation, which your card issuer releases according to its own timetable. We
          may refuse, shorten or end a Trial at any time and at our sole discretion, including where we
          suspect abuse, multiple accounts or fraud.
        </p>
      </>
    ),
  },
  {
    id: 'fees',
    title: 'Subscriptions, fees and automatic renewal',
    body: (
      <>
        <p>
          Fees are charged per Agent per billing period at the prices shown on our website or at checkout when
          you subscribe, and are payable in advance in US dollars.{' '}
          <strong>
            Your Subscription renews automatically at the end of each billing period for a period of the same
            length, and you authorise us to charge your payment method on file the then-current fee for each
            renewal, without further action or approval from you, until you cancel.
          </strong>
        </p>
        <p>
          If you add Agents or upgrade your plan during a billing period, you authorise us to charge
          immediately a prorated fee for the remainder of that period; the new number of Agents or plan then
          applies to every renewal. Removing Agents or downgrading takes effect at the next renewal and does
          not entitle you to any refund or credit for the current period.
        </p>
        <p>
          We may change our prices. Any price change applies from your next renewal after we have given you at
          least 30 days&apos; notice by email or in the Service. If you do not agree to the change, you must
          cancel before the renewal; continuing your Subscription after the change takes effect means you
          accept the new price.
        </p>
        <p>
          Fees exclude all taxes, levies and duties (including sales, use, value added and goods and services
          taxes), which you are responsible for paying, other than taxes on our net income. Where we are
          required to collect tax, we will add it to your invoice.
        </p>
        <p>
          Payments are processed by our third-party payment processor, Converge, a payment platform of Elavon,
          Inc. Your card details are sent directly to the processor and are not stored on our servers; we keep
          only a reference (token) and the card brand, last four digits and expiry date. By providing a
          payment method you represent that you are authorised to use it, and you authorise us and our
          processor to store it and charge it as described in these Terms. You must keep your payment details
          current. We may use card network updater services to refresh expired card details.
        </p>
        <p>
          If a payment fails, we may retry the charge, notify you and suspend access to the Service until all
          outstanding amounts are paid. Amounts not paid when due may accrue interest at 1.5% per month or the
          maximum rate permitted by law, whichever is lower. You will reimburse our reasonable costs of
          collection, including collection agency fees, attorneys&apos; fees and court costs. If an amount
          remains unpaid for 30 days after the first failed payment, we may terminate your Subscription and
          delete your Workspace in accordance with section 18.
        </p>
      </>
    ),
  },
  {
    id: 'cancellation',
    title: 'Cancellation',
    body: (
      <>
        <p>
          You may cancel your Subscription at any time online in Settings, Billing, or by writing to{' '}
          <Mail to={C.billingEmail} /> from the email address of a Workspace owner. Cancellation takes effect
          at the end of the current Trial or billing period. You keep access until then, and you will not be
          charged again.
        </p>
        <p>
          Cancellation does not entitle you to a refund or credit of any fees already paid or due, including
          fees for the remainder of a monthly or yearly billing period. See our{' '}
          <Link href="/legal/refund-policy">Refund Policy</Link>.
        </p>
      </>
    ),
  },
  {
    id: 'refunds',
    title: 'No refunds',
    body: (
      <p>
        <strong>
          Except as expressly stated in our Refund Policy or as required by law that cannot be excluded, all
          fees are non-refundable and non-creditable,
        </strong>{' '}
        including for partial billing periods, unused Agents, downgrades, periods in which you did not use the
        Service, and suspension or termination of your account for breach of these Terms. The{' '}
        <Link href="/legal/refund-policy">Refund Policy</Link> forms part of these Terms.
      </p>
    ),
  },
  {
    id: 'chargebacks',
    title: 'Payment disputes and chargebacks',
    body: (
      <>
        <p>
          If you believe you have been charged in error, you agree to contact us at{' '}
          <Mail to={C.billingEmail} /> within 30 days of the charge and to give us a reasonable opportunity to
          investigate and resolve the issue before contacting your bank or card issuer. Most billing questions
          are resolved quickly this way.
        </p>
        <p>
          Initiating a chargeback or payment dispute for a charge that was authorised under these Terms is a
          material breach of these Terms. If you do so, we may immediately suspend or terminate your
          Workspace, contest the dispute by providing your card issuer with records of your sign-up, your
          acceptance of these Terms, the trial reminder we sent and your use of the Service, and recover from
          you the disputed amount together with any chargeback fees, processor fees and collection costs we
          incur. We may refuse to provide the Service to you or your organisation in the future.
        </p>
      </>
    ),
  },
  {
    id: 'acceptable-use',
    title: 'Acceptable use',
    body: (
      <>
        <p>You must not, and must not allow anyone else to, use the Service to:</p>
        <ul>
          <li>break any law or regulation, or infringe or misappropriate the rights of any person;</li>
          <li>
            send spam, unsolicited marketing, phishing, chain letters or other messages that the recipient has
            not agreed to receive;
          </li>
          <li>
            upload or send malware, or content that is unlawful, defamatory, harassing, abusive, threatening,
            obscene, hateful or that exploits minors;
          </li>
          <li>
            collect payment card numbers, government identification numbers, health information, biometric
            data or other special categories of data through chat, unless you have a lawful basis and
            appropriate safeguards and have agreed this with us in writing;
          </li>
          <li>
            impersonate any person or misrepresent your identity or affiliation, including by pretending to be
            a human when you use automated replies where the law requires disclosure;
          </li>
          <li>
            probe, scan or test the vulnerability of the Service, breach or circumvent security or
            authentication, or access data that is not yours;
          </li>
          <li>
            interfere with or disrupt the Service, impose an unreasonable load on our infrastructure, or
            exceed rate limits;
          </li>
          <li>
            copy, modify, reverse engineer, decompile or disassemble the Service, or attempt to derive its
            source code, except to the extent applicable law expressly permits despite this restriction;
          </li>
          <li>
            resell, sublicense, rent, lease, frame or make the Service available to third parties as a service
            bureau, or use it to build a competing product or to benchmark it for publication without our
            written consent;
          </li>
          <li>
            use the Service on behalf of a person or in a country subject to sanctions, as described in
            section 24.
          </li>
        </ul>
        <p>
          We may investigate suspected violations and may remove content, disable widgets or suspend accounts
          at our sole discretion to protect the Service, our customers, End Users or third parties.
        </p>
      </>
    ),
  },
  {
    id: 'customer-data',
    title: 'Customer Data',
    body: (
      <>
        <p>
          As between you and us, you own your Customer Data. You grant us and our service providers a
          worldwide, non-exclusive, royalty-free licence to host, copy, process, transmit and display Customer
          Data as needed to provide, secure, support and improve the Service and as otherwise permitted by
          these Terms and our Privacy Policy. We may create and use aggregated or de-identified data that does
          not identify you or any End User for any lawful purpose, including improving the Service.
        </p>
        <p>
          You are solely responsible for your Customer Data and for the way you collect and use it. With
          respect to End User personal data, you are the controller (or business) and we process it on your
          behalf as your processor (or service provider), in accordance with your instructions as expressed
          through your configuration of the Service. Our <Link href="/legal/privacy">Privacy Policy</Link>{' '}
          explains how we handle personal data.
        </p>
        <p>
          We do not guarantee that Customer Data will not be lost. You are responsible for exporting and
          keeping copies of data you need.
        </p>
      </>
    ),
  },
  {
    id: 'your-compliance',
    title: 'Your obligations to End Users',
    body: (
      <>
        <p>You represent, warrant and agree that you will:</p>
        <ul>
          <li>
            provide End Users with all notices, and obtain all consents, required by applicable law for the
            chat widget, for cookies and similar technologies, for the collection of IP addresses, network and
            location information, page views and chat content, and for the recording and retention of
            conversations;
          </li>
          <li>
            have and maintain a privacy notice on each website where you install the widget that accurately
            describes your use of the Service;
          </li>
          <li>
            use the Service&apos;s consent and privacy settings as needed to comply with the laws that apply
            to you, including data protection, electronic communications, consumer protection and wiretapping
            or call recording laws;
          </li>
          <li>
            respond to End User requests to exercise their privacy rights, using the tools we provide where
            helpful.
          </li>
        </ul>
        <p>
          We provide tools to help you comply but do not give legal advice, and the configuration of the
          Service is your responsibility.
        </p>
      </>
    ),
  },
  {
    id: 'third-parties',
    title: 'Third-party services',
    body: (
      <p>
        The Service may let you sign in with, connect to or send data to third-party services, such as Google
        sign-in, webhooks to your own systems, email providers and payment processors. Your use of third-party
        services is governed by their own terms and privacy policies. We do not control and are not
        responsible for third-party services, their availability, or how they handle data you choose to send
        them.
      </p>
    ),
  },
  {
    id: 'ip',
    title: 'Intellectual property and feedback',
    body: (
      <>
        <p>
          The Service, including its software, design, text, graphics, logos and the {C.product} name and
          marks, is owned by {C.legalName} and its licensors and is protected by intellectual property laws.
          Except for the limited rights expressly granted in these Terms, we reserve all rights, and no rights
          are granted by implication or otherwise.
        </p>
        <p>
          If you give us suggestions, ideas or other feedback about the Service, you grant us a perpetual,
          irrevocable, worldwide, royalty-free licence to use and exploit it for any purpose without
          restriction or compensation to you.
        </p>
        <p>
          You allow us to identify you as a customer, including by name and logo, on our website and in
          marketing materials, unless you ask us in writing not to.
        </p>
      </>
    ),
  },
  {
    id: 'confidentiality',
    title: 'Confidentiality',
    body: (
      <p>
        Each party will protect the other&apos;s non-public information that is marked or reasonably
        understood to be confidential using at least reasonable care, and will use it only to perform under
        these Terms. This obligation does not apply to information that is or becomes public through no fault
        of the receiving party, was already known to it, is independently developed, or is lawfully received
        from a third party. A party may disclose confidential information where required by law, after giving
        notice to the other party where lawful.
      </p>
    ),
  },
  {
    id: 'suspension',
    title: 'Suspension',
    body: (
      <p>
        We may suspend all or part of your access to the Service immediately, with or without notice, if we
        reasonably believe that you have breached these Terms, that your use poses a security risk or may harm
        us, the Service or any third party, that suspension is required by law, or that any amount you owe is
        overdue. Fees continue to accrue during a suspension, and suspension does not entitle you to any
        refund or credit.
      </p>
    ),
  },
  {
    id: 'termination',
    title: 'Term and termination',
    body: (
      <>
        <p>
          These Terms apply from when you first use the Service until your Subscription ends or is terminated.
          We may terminate your Subscription or these Terms for any reason by giving you 30 days&apos; notice,
          or immediately if you breach these Terms, fail to pay, become insolvent, or if we are required to do
          so by law. If we terminate for convenience (and not for any reason connected with you), we will
          refund the prepaid fees for the unexpired part of your billing period, and this is your sole remedy.
        </p>
        <p>
          When your Subscription ends, your access to the Service stops. You may export your Customer Data
          before then. We may delete your Workspace and all Customer Data 30 days after the end of your
          Subscription, or sooner if the law requires, and we have no obligation to keep or return Customer
          Data after that. Sections that by their nature should survive termination survive, including
          sections 7, 9, 10, 12, 13, 15, 16 and 19 to 26.
        </p>
      </>
    ),
  },
  {
    id: 'disclaimers',
    title: 'Disclaimers',
    body: (
      <p className="site-caps">
        To the maximum extent permitted by law, the Service is provided &quot;as is&quot; and &quot;as
        available&quot;, with all faults and without warranty of any kind. {C.legalName}, its affiliates,
        licensors and suppliers disclaim all warranties, express, implied or statutory, including implied
        warranties of merchantability, fitness for a particular purpose, title, non-infringement, accuracy,
        quiet enjoyment and any warranties arising from course of dealing or usage of trade. We do not warrant
        that the Service will be uninterrupted, timely, secure or error free, that defects will be corrected,
        that messages, notifications or files will be delivered, that visitor location, network or IP
        information is accurate, or that the Service will meet your requirements or produce any particular
        result. You use the Service at your own risk.
      </p>
    ),
  },
  {
    id: 'liability',
    title: 'Limitation of liability',
    body: (
      <>
        <p className="site-caps">
          To the maximum extent permitted by law, in no event will {C.legalName} or its affiliates, officers,
          members, managers, employees, agents, licensors or suppliers be liable for any indirect, incidental,
          special, consequential, exemplary or punitive damages, or for any loss of profits, revenue, sales,
          business, goodwill, data or use, cost of substitute services, or business interruption, however
          caused and under any theory of liability (contract, tort including negligence, strict liability or
          otherwise), even if advised of the possibility of such damages.
        </p>
        <p className="site-caps">
          To the maximum extent permitted by law, our total aggregate liability arising out of or relating to
          these Terms or the Service will not exceed the greater of (a) the fees you actually paid to us for
          the Service in the three (3) months immediately before the event giving rise to the liability, and
          (b) one hundred US dollars (US $100).
        </p>
        <p>
          These limitations apply even if a remedy fails of its essential purpose, and they are an essential
          basis of the bargain between you and us. Some jurisdictions do not allow certain limitations, in
          which case they apply to the fullest extent permitted.
        </p>
      </>
    ),
  },
  {
    id: 'indemnity',
    title: 'Indemnification',
    body: (
      <p>
        You will defend, indemnify and hold harmless {C.legalName} and its affiliates, officers, members,
        managers, employees and agents from and against all claims, demands, actions, losses, damages,
        liabilities, fines, penalties, costs and expenses (including reasonable attorneys&apos; fees) arising
        out of or relating to (a) your Customer Data, (b) your use of the Service or your websites, (c) your
        breach of these Terms or of applicable law, (d) any failure to give notices to or obtain consents from
        End Users, and (e) any dispute between you and an End User, Agent or third party. We may assume the
        exclusive defence and control of any matter subject to indemnification, at your expense, and you will
        cooperate with our defence.
      </p>
    ),
  },
  {
    id: 'disputes',
    title: 'Dispute resolution, arbitration and class action waiver',
    body: (
      <>
        <p>
          <strong>Informal resolution.</strong> Before starting any claim, you agree to contact us at{' '}
          <Mail to={C.legalEmail} /> with a written description of the dispute and to try in good faith to
          resolve it informally for at least 60 days.
        </p>
        <p>
          <strong>Binding arbitration.</strong> Any dispute, claim or controversy arising out of or relating
          to these Terms or the Service, including their formation, interpretation, breach, termination,
          enforceability or validity, and the arbitrability of any claim, will be finally resolved by binding
          arbitration administered by the American Arbitration Association under its Commercial Arbitration
          Rules, before a single arbitrator. The seat of arbitration is {C.arbitrationSeat}, and the
          arbitration will be conducted in English. Judgment on the award may be entered in any court of
          competent jurisdiction. Either party may instead bring an individual claim in small claims court,
          and either party may seek injunctive relief in court to protect its intellectual property or
          confidential information.
        </p>
        <p className="site-caps">
          Class action and jury trial waiver. You and {C.legalName} each agree that claims may be brought only
          in an individual capacity, and not as a plaintiff or class member in any purported class,
          consolidated, collective or representative proceeding. The arbitrator may not consolidate claims of
          more than one person or preside over any form of class or representative proceeding. You and{' '}
          {C.legalName} each waive the right to a trial by jury.
        </p>
        <p>
          <strong>Time limit.</strong> Any claim arising out of or relating to these Terms or the Service must
          be started within one (1) year after the claim arose, or it is permanently barred, to the extent
          permitted by law.
        </p>
        <p>
          If the class action waiver is found unenforceable for a claim, that claim will be severed and heard
          in the courts named in section 23, and the remaining claims will still be arbitrated.
        </p>
      </>
    ),
  },
  {
    id: 'law',
    title: 'Governing law and venue',
    body: (
      <p>
        These Terms and any dispute arising out of or relating to them are governed by the laws of{' '}
        {C.governingLaw}, without regard to conflict of laws rules. The United Nations Convention on Contracts
        for the International Sale of Goods does not apply. Subject to section 22, the state and federal
        courts located in Delaware have exclusive jurisdiction, and you consent to their personal jurisdiction
        and venue.
      </p>
    ),
  },
  {
    id: 'export',
    title: 'Export controls and sanctions',
    body: (
      <p>
        You represent that you are not located in, organised under the laws of, or ordinarily resident in a
        country or region subject to comprehensive US sanctions, and that you are not on, or owned or
        controlled by anyone on, any US government restricted party list. You will comply with all applicable
        export control and sanctions laws in your use of the Service.
      </p>
    ),
  },
  {
    id: 'changes',
    title: 'Changes to these Terms',
    body: (
      <p>
        We may change these Terms from time to time. We will post the updated Terms on this page and update
        the &quot;Last updated&quot; date, and for material changes we will give you notice by email or in the
        Service at least 15 days before they take effect. Your continued use of the Service after the changes
        take effect constitutes acceptance. If you do not agree to the changes, you must stop using the
        Service and cancel your Subscription before they take effect.
      </p>
    ),
  },
  {
    id: 'general',
    title: 'General',
    body: (
      <>
        <p>
          <strong>Entire agreement.</strong> These Terms, together with the documents they reference and any
          order form we sign with you, are the entire agreement between you and us about the Service and
          supersede all prior agreements and understandings. Any purchase order or other terms you provide are
          rejected and have no effect.
        </p>
        <p>
          <strong>Assignment.</strong> You may not assign or transfer these Terms without our prior written
          consent. We may assign these Terms without your consent, including to an affiliate or in connection
          with a merger, acquisition, reorganisation or sale of assets.
        </p>
        <p>
          <strong>Force majeure.</strong> We are not liable for any delay or failure to perform caused by
          events beyond our reasonable control, including outages of hosting, network, power or third-party
          services, cyberattacks, labour disputes, acts of government, natural disasters, epidemics, war or
          terrorism.
        </p>
        <p>
          <strong>Severability and waiver.</strong> If any provision is held invalid or unenforceable, it will
          be enforced to the maximum extent permissible and the remaining provisions remain in full force. Our
          failure to enforce any right is not a waiver of it.
        </p>
        <p>
          <strong>Notices and electronic communications.</strong> We may give notices by email to the address
          on your account, by notice in the Service or by posting on our website. You consent to receive
          communications from us electronically and agree that they satisfy any legal requirement that
          communications be in writing. Legal notices to us must be sent to <Mail to={C.legalEmail} />.
        </p>
        <p>
          <strong>Relationship.</strong> The parties are independent contractors. Nothing in these Terms
          creates a partnership, joint venture, agency or employment relationship. There are no third-party
          beneficiaries of these Terms.
        </p>
        <p>
          <strong>Language and headings.</strong> These Terms are written in English, and the English version
          prevails over any translation. Headings are for convenience only.
        </p>
      </>
    ),
  },
  {
    id: 'contact',
    title: 'Contact',
    body: (
      <p>
        {C.legalName}, operator of {C.product}. Questions about these Terms: <Mail to={C.legalEmail} />.
        Billing: <Mail to={C.billingEmail} />. Support: <Mail to={C.supportEmail} />.
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalDoc
      kicker="Legal"
      title="Terms of Use"
      intro={
        <p>
          {C.product} is a product of {C.legalName}. These Terms explain the rules for using {C.product}, how
          billing and free trials work, and the limits of our responsibility. Please read them carefully.
        </p>
      }
      sections={sections}
    />
  );
}
