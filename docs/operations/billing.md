# Billing operations (Converge by Elavon)

Talkivio sells per-agent subscriptions (Starter, Team, Business; monthly or yearly) with a 14-day free trial that
needs a card and converts automatically. Prices, plan limits and the trial length live in one place,
`packages/contracts/src/plans.ts`, which the API (charges, limits), the dashboard (Settings, Billing) and the public
website (pricing) all read.

## How it works

| Step                            | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-up                         | `/signup?plan=team&cycle=yearly` creates the workspace with a billing account in state `incomplete`. Everything except billing answers **402 PAYMENT_REQUIRED** and the chat widget does not load.                                                                                                                                                                                                                                                                                 |
| Payment step (`/billing/setup`) | The owner picks plan, cycle and agents. The API returns the exact automatic-renewal wording (`GET /billing/quote`); the owner ticks the agreement and adds a card in Converge's Lightbox. The card number goes from the browser to Converge; we receive a token, check it server to server (`ccquerytoken`) and store it encrypted. The agreed wording, terms version, time, IP address and browser are stored in `billing_consents` (insert-only). The trial starts (`trialing`). |
| Trial reminder                  | 7 days before the trial ends the owner gets an email with the date, amount and how to cancel (card network rules).                                                                                                                                                                                                                                                                                                                                                                 |
| First charge                    | When the trial ends the stored card is charged (`ccsale`, recurring) for the plan, cycle and agents at that moment. A receipt is emailed.                                                                                                                                                                                                                                                                                                                                          |
| Renewals                        | Charged at the start of each period. Downgrades and fewer agents scheduled during the period apply from the renewal.                                                                                                                                                                                                                                                                                                                                                               |
| Upgrades                        | Charged at once for the rest of the period (prorated to the second); the plan applies immediately.                                                                                                                                                                                                                                                                                                                                                                                 |
| Failed payment                  | `past_due`: retried after 1, 2, 2 and 2 days while everything keeps working, one email to the owner. When the 7-day grace period ends unpaid the workspace is `suspended` (402, widget hidden). A new card pays at once and reopens it; the paused days are not charged.                                                                                                                                                                                                           |
| Cancellation                    | Settings, Billing → Cancel. Access continues to the end of the trial or paid period, then `ended` (402). Nothing is refunded (Refund Policy). A cancelled owner can resume before the end, or restart later (charged at once, no second trial).                                                                                                                                                                                                                                    |

Every attempt is recorded in `billing_charges` (insert-only) with a per-period invoice number, so a period is never
charged twice: a retry reuses the number and an approved charge for it is treated as paid.

A charge whose outcome is unknown (the request timed out after it was sent) sets `needs_review` on the account and is
**never retried automatically**. Check the transaction in the Converge portal (search the invoice number), then either
record the approval or clear the flag:

```sql
-- After confirming in Converge that the charge did NOT go through: let the sweep retry it.
UPDATE billing_accounts SET needs_review = false WHERE tenant_id = '<tenant>';
```

If Converge shows it was approved, set the period as paid (`state = 'active'`, `current_period_start/end`) and clear
the flag; add an approved row to `billing_charges` as the owner role so the receipt history is complete.

## Configuration

```
BILLING_PROVIDER=converge        # none (default: nothing is charged, every feature is on) | converge | fake (tests only)
CONVERGE_ENV=demo                # demo while testing, production when live
CONVERGE_MERCHANT_ID=...
CONVERGE_USER_ID=...             # an API user (not a person's login)
CONVERGE_PIN=...                 # that user's terminal PIN
BILLING_SWEEP_SECONDS=300        # how often the worker runs reminders, charges and retries
```

`BILLING_PROVIDER=fake` is refused in production, and `converge` without all three credentials is refused at start-up.
Set the same values for the API and the worker.

On a Compose server (deploy/) the same settings live in `deploy/talkivio.env` with a `TALKIVIO_` prefix
(`TALKIVIO_BILLING_PROVIDER`, `TALKIVIO_CONVERGE_ENV`, `TALKIVIO_CONVERGE_MERCHANT_ID`, `TALKIVIO_CONVERGE_USER_ID`), and
Compose passes them to the API, gateway and worker. Type the PIN with `./scripts/set-secret.sh TALKIVIO_CONVERGE_PIN`
(it never appears on screen), run `./scripts/check-env.sh`, then redeploy the running commit with
`./scripts/deploy.sh <commit>`. Turning billing off later never locks anyone out: with
`BILLING_PROVIDER=none` the API ignores billing states and plan limits.

Run the sweep once by hand (same work the worker does): `node dist/billing-sweep.js`.

## Go-live checklist (Converge)

1. Ask Elavon to enable **tokenization (Card Manager / stored credentials)** and **recurring / card-on-file
   transactions** on the merchant account, and create an API user with a PIN.
2. In Converge, allow-list the **public IP address of the API server** for the XML API, and add the dashboard's
   domain (for example `https://app.example.com`) to the **Lightbox referrer** list.
3. Test on a **demo account** first (`CONVERGE_ENV=demo`): start a trial with a Converge test card, then run
   `node dist/billing-sweep.js` after moving `trial_ends_at` into the past in a staging database. Confirm:
   - the Lightbox opens and returns a token (`ssl_token`) on approval;
   - `ccquerytoken` returns the masked card number and expiry for that token;
   - `ccsale` with `ssl_token` and `ssl_recurring_flag=1` is approved and shows in the Converge portal under the
     invoice number.
     The field names follow the Converge developer guide; if a field is named differently on your account, adjust
     `apps/api/src/features/billing/converge.gateway.ts` and its unit test.
4. Set the statement descriptor in Converge to something customers recognise (for example `TALKIVIO`), so trial
   conversions are not disputed as unknown charges.
5. Switch to `CONVERGE_ENV=production` with the production credentials, restart the API and worker, and make one real
   low-value charge you refund from the Converge portal.

## Disputes and refunds

- The Refund Policy allows refunds only for duplicate charges, legal requirements, or our own termination. Refunds are
  issued from the Converge portal; note them in the support ticket.
- For a chargeback, export the evidence: the consent row (exact wording, time, IP, browser), the trial reminder in
  `outbound_emails`, the receipts and the workspace's usage. All of it is kept even after cancellation.
