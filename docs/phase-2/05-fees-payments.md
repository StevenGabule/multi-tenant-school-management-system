# Phase 2.5 — Fees + Payments: the money domain

> **Concepts:** double-entry bookkeeping, idempotent payment intents, settlement reconciliation, webhook handling under unreliable delivery, the chargeback flow, money + currency types, audit retention, PCI scope minimization
> **Estimated effort:** 5 weekends — the hardest non-IAM milestone
> **Status:** Not Started
> **Prerequisites:**
> - Milestone 2.0 complete (alerting + Pact + load tests are non-negotiable for money paths)
> - Milestone 2.4 helpful (the audit + history mindset transfers)

---

## What you'll learn

- **Double-entry bookkeeping**: every transaction is two entries (debit + credit) summing to zero. The accountant's invariant; the system's correctness gate.
- **Idempotent payment intents**: the user clicks "pay" twice; the system charges them once. The payment provider's idempotency-key contract.
- **Settlement reconciliation**: the daily process that matches your records against the payment provider's records and flags discrepancies.
- **Webhook handling under unreliable delivery**: Stripe/Razorpay retry webhooks indefinitely with exponential backoff. Your endpoint must be idempotent AND must not reject + retry the same event.
- **Money + currency types**: never `number`; always `Money(amount: BigInteger, currency: string)`. Currency conversion at a fixed rate per invoice.
- **PCI DSS scope minimization**: never touch raw card numbers. The provider's SDK tokenizes; you store the token. Your PCI scope is "we handle tokens" (SAQ-A territory), not "we handle cards."

---

## Why this matters (senior perspective)

Money is the domain where bugs become legal problems. A student charged twice = parent escalation. A failed webhook = revenue lost. A reconciliation gap = audit finding. The patterns are well-known; the discipline to apply them under deadline pressure is what separates senior engineers.

The senior posture has four parts:

1. **Money types are non-negotiable.** A `number` field for currency in 2026 is a code-review block. There is no shortcut; `BigInteger` cents (or microunits for some currencies) + a currency code, always.
2. **Idempotency is the contract.** Every endpoint that touches money accepts an `Idempotency-Key` header AND uses it. Phase 1.5 introduced the pattern for sagas; this milestone applies it everywhere.
3. **Reconciliation is the truth.** The application's idea of revenue is a hypothesis; the bank's idea is the truth. The daily reconciliation job exists to close the gap; gaps that can't close go to humans.
4. **PCI scope is a feature.** Stay out of scope by not handling cards. Pass everything through Stripe Elements / Razorpay Checkout; never POST a card number to your own server. The boundary is the line.

---

## Hands-on plan

### Step 1 — Generate `fees-service` + `payments-service`

Two new services:

- `fees-service`: owns the chart of fees (tuition, transport, lunch, etc.), generates invoices, tracks dues per student.
- `payments-service`: owns payment intents, settled payments, refunds, the integration with the provider.

Both follow Phase 1's clean-architecture pattern. Both have tenant-scoped tables under RLS. Both emit events to the outbox.

### Step 2 — Money type

A shared `libs/money` lib:

```typescript
class Money {
  constructor(public readonly minorUnits: bigint, public readonly currency: 'USD' | 'INR' | 'EUR') {}
  add(other: Money): Money { /* same currency check */ }
  subtract(other: Money): Money { /* ... */ }
  // No multiply by another Money; only by scalar.
  multiplyByScalar(n: number): Money { /* ... */ }
  toString(): string { return `${this.formatted()} ${this.currency}`; }
}
```

Every persisted column is `int8` for minorUnits + `text` for currency. NEVER `numeric` or `decimal` — the developer error rate on those is higher than the storage savings.

### Step 3 — Invoice model + chart of accounts

The accounting model:

- `account`: chart of accounts. Tenant-scoped (every school's chart is its own). Examples: `1000-Cash`, `4000-Tuition Revenue`, `1200-Tuition Receivable`.
- `journal_entry`: one row per accounting event. Tenant-scoped, immutable.
- `journal_line`: 2+ rows per `journal_entry`, debit/credit, sum to zero.

A `tuition_invoice` is a journal entry: `DR Receivable 50,000` / `CR Tuition Revenue 50,000`. A payment: `DR Cash 50,000` / `CR Receivable 50,000`. The receivable balance goes to zero — the tuition is paid.

### Step 4 — Payment intents + idempotency

The flow:

1. Parent clicks "Pay tuition." BFF calls `payments-service` to create an intent: `POST /api/payments/intents` with `Idempotency-Key: <invoice_id>:<attempt>`.
2. payments-service returns a provider-side intent token (e.g., Stripe's `client_secret`).
3. Parent's browser completes payment via Stripe Elements (zero card data on our servers).
4. Stripe sends a webhook to `POST /api/payments/webhooks/stripe`.
5. The webhook handler verifies the signature, looks up the intent, and IF unprocessed, emits a `payment.settled` event.
6. The settlement event drives the journal entry (Cash / Receivable).

Step 5 is where most bugs live. Stripe will retry the same webhook for hours if you 5xx. Your handler must:
- Verify signature → reject unsigned with 400 (Stripe won't retry).
- Look up by Stripe event ID → if already processed, return 200 (Stripe stops).
- Otherwise, atomically: insert into `processed_webhook` AND emit `payment.settled` AND return 200.

### Step 5 — Settlement reconciliation

A daily job (or hourly for high-volume tenants):

1. Pull yesterday's settlements from Stripe via their API.
2. Pull yesterday's `payment.settled` journal entries from our DB.
3. Match by Stripe payment_intent_id. Three buckets:
   - **Match**: both sides agree. Done.
   - **Stripe has it, we don't**: the webhook never arrived. Backfill the journal entry; alert if the invoice is overdue.
   - **We have it, Stripe doesn't**: the rarest case — typically a test-mode payment that hit production. Investigate manually.

The reconciliation job emits its own metrics: matched count, gaps in each direction, total dollar variance. Variance > 0.01% → P0 alert.

### Step 6 — Refund flow

A refund is a journal entry reversal: `DR Tuition Revenue` / `CR Cash`. The payments-service calls Stripe's refund API + records the reversal. Same idempotency contract. Same reconciliation.

### Step 7 — Chargeback handling

A chargeback is a customer-initiated reversal via their bank. Stripe sends a `charge.dispute.created` webhook. The handler:

1. Records the dispute on the invoice (status: `disputed`).
2. Notifies the school admin (via the notification path; outbox event).
3. Pauses any auto-charges for this parent's invoices until resolved.

The dispute resolution flow is largely manual (gathering evidence, submitting via Stripe dashboard). The codebase's job is to capture the state machine.

### Step 8 — BFF + admin views

The parent's `bff-parent` dashboard gains a "balance + recent payments" panel. The admin BFF (or admin endpoints on existing services) shows the per-tenant aging report: invoices outstanding by 30/60/90 days.

### Step 9 — Tests + drill

- **Idempotency**: POST /api/payments/intents twice with the same Idempotency-Key returns the same intent ID; only one provider intent is created.
- **Webhook replay**: Stripe sends the same webhook 3 times; one settlement journal entry results.
- **Reconciliation gap**: deliberately drop a webhook; the next-day reconciliation surfaces the gap; the backfill recovers it.
- **Refund**: full refund and partial refund both produce correct journal entries; reconciliation matches.
- **Chargeback**: a dispute pauses future auto-charges; admin can resolve.
- **Money math**: 100 separate $0.01 invoices total $1.00 exactly (no float drift).

### Step 10 — ADRs

- `adr/0031-money-domain-modeling.md` — Money type, double-entry, the immutable journal.
- `adr/0032-payment-provider-strategy.md` — Stripe vs Razorpay vs PayU; primary + fallback; the abstraction over providers.
- `adr/0033-reconciliation-cadence.md` — daily vs hourly; the variance thresholds for alerting; the manual-review escalation.

---

## Definition of done

- [ ] `fees-service` + `payments-service` running.
- [ ] `libs/money` with the Money type; no floating-point currency anywhere.
- [ ] Chart of accounts + journal entries persisted; debits-equal-credits invariant enforced.
- [ ] Payment intent creation idempotent via `Idempotency-Key`.
- [ ] Webhook handler verifies signature, dedups by event ID, emits `payment.settled` event.
- [ ] Daily reconciliation job; variance metric on dashboard; alert at >0.01%.
- [ ] Refund flow works; produces correct journal entries.
- [ ] Chargeback handling: dispute state captured; admin notification fires.
- [ ] PCI scope: zero card data crosses our network (verified by code review + monitoring).
- [ ] Tests: idempotency, webhook replay, reconciliation gap recovery, money math precision.
- [ ] ADRs 0031, 0032, 0033 written.

---

## Reflection questions

1. **Why `bigint` minor units instead of `decimal` for currency? Walk through a bug that decimal would have caused.**
2. **Stripe sends the same `payment.settled` webhook 7 times over 4 hours. Trace the path: how many journal entries result? Why?**
3. **The reconciliation job finds a gap: Stripe charged the parent, we don't have a record. What's the resolution flow?**
4. **A parent disputes a charge. The school admin marks it "evidence submitted." Stripe rules against them — what happens in our system?**
5. **A new tenant in India needs UPI payments (Razorpay). Your existing code is Stripe-shaped. How much code changes?**

---

## References

- Stripe webhooks docs: <https://stripe.com/docs/webhooks>
- "Patterns of Enterprise Application Architecture" — Fowler, chapter on accounting patterns
- PCI DSS SAQ-A scope: <https://www.pcisecuritystandards.org/document_library/>
- "Double-Entry Bookkeeping" — accounting basics; the engineer-friendly intro
- Internal:
  - `docs/adr/0011-saga-orchestration-vs-choreography.md` — the saga pattern this milestone applies to refunds
  - Phase 1.5's idempotency pattern (the receiving side of payment retries)
