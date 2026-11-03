-- =============================================================
-- RecoverAI — PayPal Sandbox Integration Schema
-- Migration 003: PayPal orders, captures, and webhook events
--
-- Run after 001_initial_schema.sql and 002_triggers.sql.
-- All tables are user-isolated with Row Level Security.
-- =============================================================

-- ── 1. paypal_orders ──────────────────────────────────────────
-- One row per PayPal order created for a recovery attempt.
-- Linked to an internal transaction; PayPal order ID is unique.
create table if not exists public.paypal_orders (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users(id) on delete cascade,
  transaction_id    uuid        not null references public.transactions(id) on delete cascade,
  case_id           uuid        references public.recovery_cases(id) on delete set null,
  paypal_order_id   text        not null,
  amount            numeric(12,2) not null,
  currency          text        not null default 'USD',
  status            text        not null default 'CREATED',
  -- CREATED | SAVED | APPROVED | VOIDED | COMPLETED | PAYER_ACTION_REQUIRED
  intent            text        not null default 'CAPTURE',
  payee_merchant_id text,
  paypal_created_at text,
  raw_response      jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint paypal_orders_order_id_unique unique (paypal_order_id)
);

alter table public.paypal_orders enable row level security;
create policy "owner" on public.paypal_orders
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists idx_paypal_orders_user       on public.paypal_orders(user_id);
create index if not exists idx_paypal_orders_tx         on public.paypal_orders(transaction_id);
create index if not exists idx_paypal_orders_case       on public.paypal_orders(case_id);
create index if not exists idx_paypal_orders_paypal_id  on public.paypal_orders(paypal_order_id);

-- ── 2. paypal_captures ────────────────────────────────────────
-- One row per capture attempt. Unique on paypal_capture_id to
-- prevent double-processing.
create table if not exists public.paypal_captures (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users(id) on delete cascade,
  paypal_order_id   text        not null references public.paypal_orders(paypal_order_id) on delete cascade,
  transaction_id    uuid        not null references public.transactions(id) on delete cascade,
  case_id           uuid        references public.recovery_cases(id) on delete set null,
  paypal_capture_id text        not null,
  status            text        not null,
  -- COMPLETED | DECLINED | PARTIALLY_REFUNDED | PENDING | REFUNDED | FAILED
  amount            numeric(12,2) not null,
  currency          text        not null default 'USD',
  final_capture     boolean     not null default false,
  seller_protection text,
  raw_response      jsonb,
  captured_at       timestamptz not null default now(),
  constraint paypal_captures_capture_id_unique unique (paypal_capture_id)
);

alter table public.paypal_captures enable row level security;
create policy "owner" on public.paypal_captures
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists idx_paypal_captures_user      on public.paypal_captures(user_id);
create index if not exists idx_paypal_captures_order     on public.paypal_captures(paypal_order_id);
create index if not exists idx_paypal_captures_tx        on public.paypal_captures(transaction_id);
create index if not exists idx_paypal_captures_capture   on public.paypal_captures(paypal_capture_id);

-- ── 3. paypal_webhook_events ──────────────────────────────────
-- Append-only log of every inbound PayPal webhook event.
-- event_id is unique to enforce idempotency — duplicate deliveries
-- are detected and no-op'd without re-processing.
create table if not exists public.paypal_webhook_events (
  id              uuid        primary key default gen_random_uuid(),
  event_id        text        not null,
  event_type      text        not null,
  resource_type   text,
  resource_id     text,
  summary         text,
  raw_payload     jsonb       not null,
  verified        boolean     not null default false,
  processed       boolean     not null default false,
  processing_error text,
  received_at     timestamptz not null default now(),
  constraint paypal_webhook_events_event_id_unique unique (event_id)
);

-- Webhook events are server-only (service-role writes, admin reads).
-- No RLS — accessed only via SUPABASE_SERVICE_ROLE_KEY on the server.
-- Merchants cannot read or write webhook events directly.
alter table public.paypal_webhook_events enable row level security;
-- No public policy: only the service-role key can access this table.

create index if not exists idx_paypal_webhook_event_id   on public.paypal_webhook_events(event_id);
create index if not exists idx_paypal_webhook_event_type on public.paypal_webhook_events(event_type);
create index if not exists idx_paypal_webhook_resource   on public.paypal_webhook_events(resource_id);
create index if not exists idx_paypal_webhook_received   on public.paypal_webhook_events(received_at desc);

-- ── 4. updated_at triggers ────────────────────────────────────
do $$
begin
  if to_regclass('public.paypal_orders') is not null
    and not exists (select 1 from pg_trigger where tgname = 'paypal_orders_updated') then
    create trigger paypal_orders_updated before update on public.paypal_orders
      for each row execute function public.set_updated_at();
  end if;
end;
$$;
