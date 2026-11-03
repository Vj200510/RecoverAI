-- Compatibility/readiness migration.
-- 001_initial_schema.sql is the canonical RecoverAI schema. The original version
-- of this file recreated every table and failed on a fresh database because the
-- same tables were already created by 001. Keep only idempotent operational
-- setup here so migrations can run from scratch in order.

create or replace function public.set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql set search_path = public;

do $$
begin
  if to_regclass('public.profiles') is not null
    and not exists (select 1 from pg_trigger where tgname = 'profiles_updated') then
    create trigger profiles_updated before update on public.profiles
      for each row execute function public.set_updated_at();
  end if;
  if to_regclass('public.merchant_settings') is not null
    and not exists (select 1 from pg_trigger where tgname = 'settings_updated') then
    create trigger settings_updated before update on public.merchant_settings
      for each row execute function public.set_updated_at();
  end if;
  if to_regclass('public.recovery_cases') is not null
    and not exists (select 1 from pg_trigger where tgname = 'cases_updated') then
    create trigger cases_updated before update on public.recovery_cases
      for each row execute function public.set_updated_at();
  end if;
end;
$$;

create index if not exists customers_user_idx on public.customers(user_id);
create index if not exists tx_user_status_idx on public.transactions(user_id, status);
create index if not exists tx_user_time_idx on public.transactions(user_id, occurred_at desc);
create index if not exists tx_customer_idx on public.transactions(customer_id);
create index if not exists tx_recovery_idx on public.transactions(user_id, recovery_status);
create index if not exists cases_user_status_idx on public.recovery_cases(user_id, status);
create index if not exists cases_prob_idx on public.recovery_cases(user_id, recovery_probability desc);
create index if not exists cases_priority_idx on public.recovery_cases(user_id, priority_score desc);
create index if not exists decisions_case_idx on public.ai_decisions(case_id);
create index if not exists decisions_user_time_idx on public.ai_decisions(user_id, created_at desc);
create index if not exists attempts_case_idx on public.recovery_attempts(case_id);
create index if not exists attempts_user_time_idx on public.recovery_attempts(user_id, created_at desc);
create index if not exists audit_user_time_idx on public.audit_events(user_id, created_at desc);
