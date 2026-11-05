# RecoverAI — AI Payment Recovery Platform

> **PayPal AI Hackathon 2026** — Build What's Next with PayPal and AI

**Live demo:** https://recoverai-9o7m.onrender.com  
**Repository:** https://github.com/Vj200510/RecoverAI

RecoverAI detects failed payments, analyses their cause using an AI agent, recommends a recovery strategy, validates every proposed action through a deterministic verification boundary, and — only after an explicit APPROVE — presents the customer with a real PayPal Sandbox checkout.

---

## Problem Statement

Payment failures cost merchants billions annually. Most recovery is either manual (slow) or blind automated retries (harmful). RecoverAI places an AI agent inside a hard safety boundary: the model proposes, the deterministic verifier decides, and nothing executes outside that boundary.

---

## Architecture

```
Failed Payment
     │
     ▼
RecoverAI AI Agent ──proposes──▶  Action Verification Layer
                                         │
                              Fresh DB + PayPal evidence
                              Merchant policy validation
                              Deterministic guardrails
                                         │
                                  APPROVE / BLOCK
                                         │
                               ┌─────────┴──────────┐
                            APPROVE               BLOCK
                               │                    │
                               ▼                    ▼
                       PayPal Checkout          Audit Log
                       (Customer approves)
                               │
                               ▼
                       Capture (server-side)
                       Verify amount + currency
                       Update transaction + case
                               │
                               ▼
                          Audit Log
```

---

## Key Features

| Feature | Implementation | Status |
|---|---|---|
| AI recovery engine | Rule-based fallback + optional AI gateway | ✅ Implemented |
| Deterministic verifier | Fresh DB evidence → merchant policy → APPROVE/BLOCK | ✅ Implemented & tested |
| PayPal OAuth 2.0 | Client-credentials flow, token cache | ✅ Sandbox verified |
| PayPal order creation | Orders API v2 | ✅ Sandbox verified |
| Customer approval flow | PayPal checkout redirect + token return | ✅ Sandbox verified |
| PayPal capture | Live status re-fetch + amount/currency verify | ✅ Sandbox verified |
| Duplicate capture protection | DB unique constraint + idempotency check | ✅ Automated tested |
| Webhook processing | Signature verify + idempotent event dispatch | ✅ Implemented |
| Audit trail | Append-only, every decision recorded | ✅ Implemented |
| Dashboard | Real DB data, no hardcoded stats | ✅ Implemented |

---

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TanStack Router, TanStack Query |
| Server | TanStack Start, Nitro (node-server) |
| Database | Supabase (PostgreSQL + Row Level Security) |
| Auth | Supabase Auth (JWT) |
| AI | Lovable AI Gateway / Gemini (deterministic fallback always available) |
| Payments | PayPal Orders API v2 (Sandbox) |
| Deployment | Render (Ohio region) |
| Language | TypeScript 5.8 |

---

## Security Architecture

- AI model never directly executes payment operations
- Every action passes through `evaluateGrounding()` — deterministic, source-grounded
- PayPal order status fetched live before every capture — frontend status never trusted
- Amount and currency sourced from the database record, not client input
- Duplicate captures blocked by unique DB constraint on `paypal_capture_id`
- Webhook events verified via PayPal's own verification endpoint
- Duplicate webhook events handled idempotently (unique constraint on `event_id`)
- `audit_events` table is append-only — no update or delete path
- Row Level Security enforces merchant-level data isolation on all tables
- `SUPABASE_SERVICE_ROLE_KEY` and `PAYPAL_CLIENT_SECRET` are server-only — never in browser bundle

---

## Database Schema

Three migration files must be applied in order:

| File | Purpose |
|---|---|
| `001_initial_schema.sql` | Core tables: profiles, merchant_settings, customers, transactions, recovery_cases, ai_decisions, recovery_attempts, audit_events |
| `20260823051127_dc58c767...sql` | Triggers (updated_at), performance indexes |
| `003_paypal_integration.sql` | PayPal tables: paypal_orders, paypal_captures, paypal_webhook_events |

---

## Setup

### Prerequisites

- Node.js 20+ (22+ recommended)
- A [Supabase](https://supabase.com) project (free tier works)
- A [PayPal Developer](https://developer.paypal.com) account (free)

### 1. Clone and install

```bash
git clone https://github.com/Vj200510/RecoverAI.git
cd RecoverAI
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
# Open .env.local and fill in your values
```

### 3. Apply Supabase migrations

Option A — Supabase CLI:
```bash
supabase link --project-ref <your-project-ref>
supabase db push --yes
```

Option B — Supabase Dashboard → SQL Editor → paste and run each migration file in order.

### 4. PayPal Sandbox credentials

1. Go to [developer.paypal.com/dashboard](https://developer.paypal.com/dashboard/)
2. Sign in → **Apps & Credentials** → **Create App** (Sandbox, Merchant type)
3. Copy **Client ID** and **Secret** into `.env.local`
4. For webhooks: your app → **Webhooks** → add `https://your-domain.com/api/paypal-webhook`
5. Copy the **Webhook ID** into `.env.local`

### 5. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Testing

All tests run against mocked HTTP/DB — no live credentials required for the automated suite.

```bash
# TypeScript type check
npm run typecheck

# ESLint (non-prettier rules)
npm run lint

# Production build (node-server preset)
NITRO_PRESET=node-server npm run build

# Problem 9 red-team + 14 boundary integration tests (mocked DB)
npm run test:red-team

# PayPal security tests — 13 checks (mocked HTTP)
npm run test:paypal

# PayPal execution boundary tests — 7 checks (mocked HTTP + DB)
npm run test:paypal-boundary

# Live Supabase integration (requires real .env.local credentials)
npm run test:live
```

---

## Deployment (Render)

```yaml
# render.yaml is included — one-click deploy
Build command:  npm install && npm run build
Start command:  node .output/server/index.mjs
Health check:   /api/health
Readiness:      /api/ready
```

Required Render environment variables — see `.env.example` for the full list.  
Set `NITRO_PRESET=node-server` and `NODE_ENV=production`.

---

## API Endpoints

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/health` | GET | None | Liveness probe (always HTTP 200) |
| `/api/ready` | GET | None | Readiness probe (HTTP 200/503) |
| `/api/paypal-webhook` | POST | None (PayPal sig) | PayPal webhook receiver |
| `/_serverFn/*` | POST | JWT | All server functions |

---

## Demo Walkthrough

### PayPal Sandbox recovery

1. Sign up at `/auth`
2. **Settings** → **Reset demo data** (seeds 120 customers, 720 transactions)
3. **Transactions** → find a `FAILED` row → copy the reference (e.g. `TXN-20260823-10001`)
4. **PayPal Recovery** → paste reference → **Create PayPal checkout**
5. Log in with a [PayPal Sandbox buyer account](https://developer.paypal.com/dashboard/accounts)
6. Approve → redirected back → payment captured automatically
7. **Audit Trail** → see `PAYPAL_ORDER_CREATED` and `PAYPAL_CAPTURE_COMPLETED`

### Hallucination demo (AI guardrail)

1. **AI Agent** → **Run bad-action demo**
2. Creates a synthetic SUCCESS transaction, proposes SMART_RETRY
3. Verifier returns **BLOCK**, executor calls = **0**
4. Evidence shows `transactions.status = SUCCESS` as the blocking fact

---

## What Is Simulated vs Real

| Feature | Real (PayPal Sandbox) | Simulated |
|---|---|---|
| OAuth token acquisition | ✅ | |
| Order creation | ✅ | |
| Customer checkout approval | ✅ | |
| Payment capture | ✅ | |
| Webhook signature verification | ✅ | |
| Recovery outcomes (retry/reminder) | | ✅ deterministic hash |
| Demo transaction dataset | | ✅ synthetic seed |

---

## Test Results (as of latest commit)

| Suite | Result |
|---|---|
| TypeScript typecheck | ✅ 0 errors |
| PayPal security tests | ✅ 13/13 |
| PayPal boundary tests | ✅ 7/7 |
| Problem 9 red-team | ✅ 6/6 |
| Problem 9 boundary integration | ✅ 14/14 |
| Production build | ✅ |

---

## Concurrency Guarantee

**No database-level atomic lock.** The verifier performs a fresh read immediately before execution, which prevents sequential TOCTOU races. A true concurrent race (two simultaneous requests for the same case) is theoretically possible without `SELECT FOR UPDATE`. This is documented honestly rather than claimed away.

---

## License

MIT — see [LICENSE](./LICENSE)
