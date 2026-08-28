begin;

create table if not exists public.price_book_quote_decisions (
  id uuid primary key default gen_random_uuid(),

  task_draft_id uuid not null
    references public.task_drafts(id) on delete restrict,

  price_book_id uuid not null
    references public.price_book(id) on delete restrict,

  quote_id uuid
    references public.quotes(id) on delete restrict,

  quote_version_id uuid
    references public.quote_versions(id) on delete restrict,

  status text not null
    check (status in ('ACTIVE', 'CONSUMED', 'SUPERSEDED')),

  execution_environment text not null
    check (execution_environment in ('TEST', 'PRODUCTION')),

  is_test boolean not null,

  policy_version text not null
    check (policy_version ~ '^hxos-price-book-v[0-9]+$'),

  input jsonb not null
    check (jsonb_typeof(input) = 'object'),

  input_hash text not null
    check (input_hash ~ '^[a-f0-9]{64}$'),

  decision jsonb not null
    check (jsonb_typeof(decision) = 'object'),

  provider_floor_cents integer not null
    check (provider_floor_cents > 0),

  expected_customer_low_cents integer not null
    check (expected_customer_low_cents > 0),

  expected_customer_high_cents integer not null
    check (
      expected_customer_high_cents >= expected_customer_low_cents
    ),

  customer_maximum_cents integer not null
    check (
      customer_maximum_cents >= expected_customer_high_cents
    ),

  margin_floor_bps integer not null
    check (margin_floor_bps between 0 and 10000),

  recommended_customer_total_cents integer not null
    check (
      recommended_customer_total_cents
      between expected_customer_low_cents
      and expected_customer_high_cents
    ),

  recommended_provider_payout_cents integer not null
    check (
      recommended_provider_payout_cents >= provider_floor_cents
    ),

  platform_margin_cents integer not null
    check (platform_margin_cents >= 0),

  valid_until timestamptz not null,
  consumed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (
    recommended_provider_payout_cents
    + platform_margin_cents
    = recommended_customer_total_cents
  ),

  check (
    platform_margin_cents * 10000
    >= recommended_customer_total_cents * margin_floor_bps
  ),

  check (
    (
      status = 'ACTIVE'
      and quote_id is null
      and quote_version_id is null
      and consumed_at is null
    )
    or (
      status = 'SUPERSEDED'
      and quote_id is null
      and quote_version_id is null
      and consumed_at is null
    )
    or (
      status = 'CONSUMED'
      and quote_id is not null
      and quote_version_id is not null
      and consumed_at is not null
    )
  )
);

create unique index if not exists price_book_quote_decisions_one_active
  on public.price_book_quote_decisions(task_draft_id)
  where status = 'ACTIVE';

create index if not exists price_book_quote_decisions_history
  on public.price_book_quote_decisions(
    task_draft_id,
    created_at desc
  );

create unique index if not exists price_book_quote_decisions_quote_version
  on public.price_book_quote_decisions(quote_version_id)
  where quote_version_id is not null;

comment on table public.price_book_quote_decisions is
  'Append-preserved deterministic Price Book decisions. Automated quote inserts must match an exact unexpired decision.';

commit;