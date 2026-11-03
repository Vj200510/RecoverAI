# RecoverAI — PayPal AI Hackathon

AI-powered payment recovery platform with real PayPal Sandbox integration.

RecoverAI detects failed payments, diagnoses their cause, generates recovery recommendations via an AI agent, validates every proposed action against authoritative database evidence through a deterministic verifier, and — only after APPROVE — presents the customer with a real PayPal Sandbox checkout.

---

## Problem Statement

Payment failures cost merchants billions annually. Most recovery attempts are either manual (slow, expensive) or blind automated retries (harmful to issuer relationships). RecoverAI solves this by placing an AI agent inside a hard safety boundary: the model proposes, the verifier decides, and nothing runs outside that boundary.

---

## Architecture

```
Failed Payment
     │
     ▼
RecoverAI AI Agent  ──proposes action──▶  Action Verification Layer
     │                                           │
     │                               Fresh DB + PayPal evidence
     │                               Merchant policy check
     │                               Deterministic guardrails
     │                                           │
     │                                    APPROVE / BLOCK
     │                                           │
     │                                    ┌──────┴──────┐
     │                                 APPROVE        BLOCK
     │                                    │              │
     │                                    ▼              ▼
     │                            PayPal Checkout    Audit Log
     │                            (Customer approves)
     │                                    │
     │                                    ▼
     │                            Capture (server-side)
     │                            Verify amount + currency
     │                            Update transaction + case
     │                                    │
     └───────────────────────────▶  Audit Log
```

**Key guarantee:** AI recommendations never reach execution without passing through `verifyAndExecuteRecoveryAction()`. This boundary cannot be bypassed.

---

## PayPal Integration

- **OAuth 2.0** client credentials flow with in-process token cache
- **Orders API v2** — create, retrieve, capture
- **Webhook processing** — signature verification, idempotent event handling
- **Sandbox only** by default — live mode requires explicit config change

### Payment flow

1. Merchant clicks "Create PayPal checkout" for a failed transaction
2. Server creates a PayPal order with amount/currency from the DB (never from client input)
3. Customer redirected to PayPal approval page
4. Customer approves → PayPal redirects back with `order_id`
5. Server re-fetches live PayPal status (never trusts frontend)
6. Server verifies amount and currency match
7. Server captures the order
8. Transaction marked RECOVERED, audit log updated

---

## Technologies

| Layer | Technology |
|---|---|
| Frontend | React 19, TanStack Router, TanStack Query |
| Server | TanStack Start, Nitro (Cloudflare Workers) |
| Database | Supabase (PostgreSQL + RLS) |
| Auth | Supabase Auth (JWT, RLS) |
| AI | Lovable AI Gateway / Google Gemini (with deterministic fallback) |
| Payments | PayPal Orders API v2 (Sandbox) |
| Type safety | TypeScript 5.8, Zod |

---

## Security Architecture

- AI model never directly executes payment operations
- Every action passes through `evaluateGrounding()` — a deterministic, source-grounded verifier
- PayPal order status fetched from PayPal before every capture — frontend status never trusted
- Amount and currency always sourced from the database record, never client input
- Duplicate captures blocked by unique DB constraint on `paypal_capture_id`
- Webhook events verified via PayPal's own verification endpoint
- Duplicate webhook events handled idempotently
- Immutable audit trail — `audit_events` is append-only
- RLS enforces merchant-level data isolation on all tables

---

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd recover-smart-agent-main
npm install   # or: bun install
```

### 2. Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Copy `Project URL` and `anon` key from Settings → API
3. Copy `service_role` key (server-only)
4. Run all migrations:

```sql
-- In Supabase Dashboard → SQL Editor, run in order:
-- supabase/migrations/001_initial_schema.sql
-- supabase/migrations/20260823051127_....sql
-- supabase/migrations/003_paypal_integration.sql
```

Or via CLI:
```bash
supabase link --project-ref <your-project-ref>
supabase db push --yes
```

### 3. PayPal Sandbox credentials

1. Go to [developer.paypal.com](https://developer.paypal.com/dashboard/)
2. Log in or create a free developer account
3. Click **Apps & Credentials** → **Create App** → select **Sandbox**
4. Copy your **Client ID** and **Client Secret**
5. To enable webhooks: go to your app → **Webhooks** → Add webhook URL: `https://your-domain.com/api/paypal-webhook`
6. Copy the **Webhook ID**

### 4. Environment variables

```bash
cp .env.local.example .env.local
# Fill in your values — see .env.local.example for descriptions
```

Required variables:

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
PAYPAL_CLIENT_ID=your-sandbox-client-id
PAYPAL_CLIENT_SECRET=your-sandbox-client-secret
PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
PAYPAL_WEBHOOK_ID=your-webhook-id  # optional for local dev
```

### 5. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Testing

```bash
# Problem 9 red-team + boundary integration (14 checks, mocked DB)
npm run test:red-team

# PayPal security tests (13 checks, mocked HTTP)
npm run test:paypal

# Live Supabase integration test (requires real credentials)
npm run test:live

# TypeScript typecheck
npm run typecheck

# Production build
npm run build
```

---

## Demo Walkthrough

### Test a successful PayPal recovery

1. Sign in at `/auth`
2. Go to **Settings** → click **Reset demo data** to seed 120 customers and 720 transactions
3. Go to **Transactions** → find a `FAILED` transaction → copy its ID (UUID)
4. Go to **PayPal Recovery** → paste the transaction ID → click **Create PayPal checkout**
5. You're redirected to the PayPal Sandbox approval page
6. Log in with a [PayPal Sandbox buyer account](https://developer.paypal.com/dashboard/accounts)
7. Approve the payment → redirected back to RecoverAI
8. The server automatically captures the payment and marks the transaction RECOVERED
9. Check the **Audit Trail** for the full `PAYPAL_ORDER_CREATED` → `PAYPAL_CAPTURE_COMPLETED` log

### Test a blocked recovery (AI guardrail demo)

1. Go to **AI Agent** (development mode only)
2. Click **Run bad-action demo** — creates a synthetic SUCCESS transaction and proposes SMART_RETRY
3. The verifier returns BLOCK, executor calls = 0
4. Evidence panel shows `transactions.status = SUCCESS` as the blocking fact

### Test the recovery agent

1. Go to **Overview** → click **Run agent on top 12**
2. The AI agent analyses up to 12 cases and recommends actions
3. Go to **Revenue at Risk** → open any case → click **Execute action**
4. The verifier approves or blocks based on fresh DB evidence

---

## Webhook Setup (Production)

1. Deploy to Cloudflare Workers: `npm run build && npx nitro deploy --prebuilt`
2. In PayPal Dashboard → your app → Webhooks:
   - URL: `https://your-domain.com/api/paypal-webhook`
   - Events: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`
3. Copy the Webhook ID to `PAYPAL_WEBHOOK_ID` in your deployment environment

---

## Modified Files

| File | Change |
|---|---|
| `src/components/console/AppShell.tsx` | Added PayPal Recovery nav entry |
| `.env.local.example` | Added PayPal and service role key docs |
| `package.json` | Added `test:paypal` and `test:live` scripts |

## New Files

| File | Purpose |
|---|---|
| `src/lib/paypal.server.ts` | PayPal OAuth, Orders API v2, webhook verification |
| `src/lib/paypal-recovery.server.ts` | Recovery order/capture logic, dashboard stats, webhook dispatch |
| `src/lib/paypal.functions.ts` | TanStack Start server functions for PayPal |
| `src/routes/api/paypal-webhook.ts` | Webhook endpoint (POST /api/paypal-webhook) |
| `src/routes/_authenticated/console.paypal.tsx` | PayPal dashboard page |
| `supabase/migrations/003_paypal_integration.sql` | paypal_orders, paypal_captures, paypal_webhook_events tables |
| `scripts/paypal-security.ts` | 13 PayPal security and integration tests |

---

## Acceptance Criteria Status

| Criterion | Status |
|---|---|
| Existing RecoverAI features continue working | ✅ |
| PayPal Sandbox OAuth | ✅ implemented, requires credentials |
| PayPal order creation | ✅ |
| PayPal customer approval | ✅ (redirect flow) |
| PayPal capture | ✅ with amount/currency verification |
| Payment status verified via PayPal | ✅ (always fetches fresh before capture) |
| AI analyses transaction info | ✅ existing engine unchanged |
| AI recovery recommendations | ✅ |
| Deterministic verification protects execution | ✅ boundary unchanged |
| Duplicate payment prevention | ✅ (unique constraint + live status check) |
| Webhook signature verification | ✅ |
| Database updates correctly | ✅ |
| Dashboard displays real data | ✅ |
| Audit logs record decisions | ✅ |
| Automated tests pass | ✅ 13/13 PayPal + 14/14 boundary + 6/6 red-team |
| README updated | ✅ |

## Requires Credentials for Full Live Verification

| Step | Requirement |
|---|---|
| PayPal OAuth test | `PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET` |
| Live order creation | Same |
| Live capture | Same + customer sandbox account |
| Webhook verification | `PAYPAL_WEBHOOK_ID` + public HTTPS endpoint |
| DB migration | `supabase db push` or manual SQL execution |

---

## Concurrency Guarantee

**NO database-level atomic protection.** The verifier performs a fresh read immediately before execution, catching sequential state changes. A true concurrent TOCTOU race (two simultaneous execute calls for the same case) is theoretically possible without `SELECT FOR UPDATE`. This is reported honestly rather than claimed away.
