import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalDoc, Mail, type LegalSection } from '@/components/site/legal';
import { COMPANY, TRIAL_DAYS, TRIAL_REMINDER_DAYS } from '@/components/site/site-config';

export const metadata: Metadata = {
  title: { absolute: 'Refund Policy | Talkivio' },
  description: `${COMPANY.product} subscriptions are non-refundable. How free trials, cancellation and billing disputes work.`,
};

const C = COMPANY;

const sections: LegalSection[] = [
  {
    id: 'summary',
    title: 'Summary',
    body: (
      <>
        <p className="site-caps">
          All payments for {C.product} are final and non-refundable. To avoid being charged, cancel before
          your free trial ends. If you cancel a paid subscription, it stays active until the end of the period
          you have paid for and is not renewed, but no refund or credit is given for any part of that period.
        </p>
        <p>
          This Refund Policy forms part of our <Link href="/legal/terms">Terms of Use</Link>. Capitalised
          terms not defined here have the meaning given in the Terms. By starting a free trial or
          subscription, you confirm that you have read, understood and accepted this policy.
        </p>
      </>
    ),
  },
  {
    id: 'trial',
    title: 'Free trials and the first charge',
    body: (
      <>
        <p>
          Every plan starts with a {TRIAL_DAYS}-day free trial. A valid credit or debit card is required to
          start it. The total due when the trial ends is shown to you before you start, and you must expressly
          agree to the automatic charge.
        </p>
        <ul>
          <li>
            <strong>Reminder.</strong> We email the account owner {TRIAL_REMINDER_DAYS} days before the trial
            ends, stating the date and amount of the first charge and how to cancel. The same information is
            shown in Settings, Billing throughout the trial.
          </li>
          <li>
            <strong>Automatic charge.</strong> If you have not cancelled when the trial ends, your card is
            charged automatically for the plan, billing period (monthly or yearly) and number of Agents in
            your workspace at that moment.
          </li>
          <li>
            <strong>Your responsibility.</strong> You are solely responsible for cancelling before the trial
            ends. A charge made after the trial ends is not refundable for any reason, including that you
            forgot to cancel, did not use the Service, did not read or receive the reminder email (for example
            because of spam filtering or an out-of-date address), or that the person who started the trial has
            left your organisation.
          </li>
          <li>
            <strong>One trial.</strong> Each organisation, card and person may have one free trial. Trials
            started to avoid payment, including through multiple accounts, may be ended and charged
            immediately.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'no-refunds',
    title: 'No refunds',
    body: (
      <>
        <p>Without limiting the summary above, we do not give refunds, credits or pro-rated amounts for:</p>
        <ul>
          <li>
            monthly or yearly subscription fees, including the first charge after a free trial and every
            renewal;
          </li>
          <li>yearly plans cancelled before the end of the year, in whole or in part;</li>
          <li>partial billing periods, or days or months remaining after you cancel;</li>
          <li>Agents you added and later removed, unused Agents or seats, or Agents who did not sign in;</li>
          <li>upgrades, or downgrades and Agent reductions, which take effect at the next renewal;</li>
          <li>periods in which you did not use the Service, or used it less than expected;</li>
          <li>dissatisfaction with the Service, or the absence of a feature you expected;</li>
          <li>price changes we notified you about before your renewal;</li>
          <li>
            suspension or termination of your account because you breached the Terms, including the Acceptable
            Use rules, or because a payment failed;
          </li>
          <li>
            interruptions, outages, degraded performance, maintenance, or failures of third-party services,
            networks or your own systems;
          </li>
          <li>taxes, except where the law requires them to be returned.</li>
        </ul>
        <p>
          Any goodwill gesture we choose to make, such as a service credit, is entirely at our discretion,
          applies only to that one occasion, creates no obligation for the future and is not an admission of
          liability. We do not give cash refunds in place of credits.
        </p>
      </>
    ),
  },
  {
    id: 'cancel',
    title: 'How to cancel',
    body: (
      <>
        <p>
          A workspace owner can cancel at any time in Settings, Billing. Cancelling takes effect at the end of
          the current trial or billing period: you keep access until then, and you will not be charged again.
          You will receive an email confirming the cancellation; keep it for your records. If you do not
          receive it, contact us before the period ends.
        </p>
        <p>
          You may also cancel by writing to <Mail to={C.billingEmail} /> from the email address of a workspace
          owner, giving your workspace name. A cancellation request takes effect when we receive it, so please
          send it in good time before the end of your trial or billing period. Deleting the chat widget from
          your website, removing your Agents or stopping using the Service does not cancel your subscription.
        </p>
        <p>
          After your subscription ends, your workspace and its data may be deleted 30 days later. Export
          anything you need before then.
        </p>
      </>
    ),
  },
  {
    id: 'exceptions',
    title: 'Limited exceptions',
    body: (
      <>
        <p>
          We will consider a refund only in the following cases, which are the only exceptions to this policy:
        </p>
        <ol>
          <li>
            <strong>Duplicate charge.</strong> You were charged more than once for the same workspace and the
            same billing period because of an error in our billing system. We refund the duplicate amount
            only.
          </li>
          <li>
            <strong>Required by law.</strong> A refund is required by a law that applies to you and cannot be
            excluded or limited by agreement.
          </li>
          <li>
            <strong>Termination for convenience.</strong> We end your subscription for our own convenience and
            not for any reason connected with you, as described in the Terms, in which case we refund the
            prepaid fees for the unused part of the period.
          </li>
        </ol>
        <p>To request a refund under one of these exceptions:</p>
        <ul>
          <li>
            write to <Mail to={C.billingEmail} /> from the email address of a workspace owner within 14 days
            of the charge; requests received later will not be considered;
          </li>
          <li>
            include the workspace name, the date and amount of the charge, the last four digits of the card
            and the exception you are relying on, with any supporting evidence;
          </li>
          <li>
            we will review the request against our billing records and decide within 30 days; our decision,
            based on our records, is final to the extent permitted by law.
          </li>
        </ul>
        <p>
          Approved refunds are made only to the original payment method, in US dollars, and may take 5 to 10
          business days or longer to appear, depending on your card issuer. We are not responsible for
          exchange rate differences or fees charged by your bank.
        </p>
      </>
    ),
  },
  {
    id: 'disputes',
    title: 'Chargebacks and payment disputes',
    body: (
      <>
        <p>
          If you do not recognise a charge or think it is wrong, contact <Mail to={C.billingEmail} /> before
          you contact your bank. Most questions are resolved within a few days.
        </p>
        <p>
          Filing a chargeback or payment dispute for a charge made in accordance with the Terms and this
          policy is a breach of the Terms. If you do so:
        </p>
        <ul>
          <li>
            your workspace may be suspended immediately until the dispute is resolved, and may be closed;
          </li>
          <li>
            we will contest the dispute and give your card issuer the evidence of the transaction, including
            your acceptance of the Terms and of the automatic charge at sign-up, the time and IP address of
            that acceptance, the trial reminder we sent, and records of your use of the Service;
          </li>
          <li>
            you remain liable for the disputed amount, and you agree to pay any chargeback fees, processor
            fees, collection costs and reasonable attorneys&apos; fees we incur;
          </li>
          <li>we may refuse to provide the Service to you or your organisation in the future.</li>
        </ul>
        <p>
          Disputes that we reasonably believe are fraudulent may be reported to the payment networks and the
          authorities.
        </p>
      </>
    ),
  },
  {
    id: 'failed',
    title: 'Failed payments',
    body: (
      <p>
        If a charge fails, we will retry it and email the account owner. Until the outstanding amount is paid,
        access to the Service may be restricted or suspended, and if it remains unpaid we may close the
        workspace as described in the Terms. Fees for the period remain payable even if access was restricted.
      </p>
    ),
  },
  {
    id: 'changes',
    title: 'Changes to this policy',
    body: (
      <p>
        We may update this Refund Policy from time to time. The version in force on the date of a charge
        applies to that charge. We will post updates on this page and update the &quot;Last updated&quot;
        date.
      </p>
    ),
  },
  {
    id: 'contact',
    title: 'Contact',
    body: (
      <p>
        Billing questions: <Mail to={C.billingEmail} />. {C.product} is a product of {C.legalName}.
      </p>
    ),
  },
];

export default function RefundPolicyPage() {
  return (
    <LegalDoc
      kicker="Legal"
      title="Refund Policy"
      intro={
        <p>
          Please read this policy before you start a free trial or subscription. It explains when you are
          charged, how to cancel, and why payments are not refunded.
        </p>
      }
      sections={sections}
    />
  );
}
