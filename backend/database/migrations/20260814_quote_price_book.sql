begin;

-- ============================================================================
-- PRICE BOOK
-- Deterministic pricing authority used by automated quote generation.
-- ============================================================================

create table if not exists public.price_book (
  id uuid primary key default gen_random_uuid(),
  category text not null unique,
  service_area text not null default 'eastside_seattle',
  base_price_cents integer not null check (base_price_cents > 0),
  price_min_cents integer not null,
  price_max_cents integer not null
    check (price_max_cents >= price_min_cents),
  min_hustler_payout_cents integer not null,
  labor_hours_band text not null,
  platform_margin_floor_pct numeric not null
    check (platform_margin_floor_pct between 0 and 60),
  price_cap_cents integer not null,
  allowed_risk_tier text not null default 'green',
  min_trust_tier integer not null default 0,
  quote_expires_hours integer not null default 72,
  dispatch_expires_hours_before_window integer not null default 2,
  refund_policy_version text not null default 'v1',
  active boolean not null default true,

  -- Deterministic Price Book v1 additions.
  policy_version text not null default 'hxos-price-book-v1',
  automation_evidence_state text not null default 'CONTROLLED_TEST_ONLY',
  completed_paid_task_count integer not null default 0,
  calibrated_at timestamptz,
  calibration_evidence_ref text,

  same_day_premium_bps integer not null default 1000,
  market_anchor_zip text not null default '98052',
  included_travel_miles numeric(6,2) not null default 5,
  travel_premium_cents_per_mile integer not null default 100,
  equipment_premium_cents integer not null default 250,
  cargo_vehicle_premium_cents integer not null default 1500,
  scope_addon_premium_cents integer not null default 1000,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Safe convergence if an older version of price_book already exists.
alter table public.price_book
  add column if not exists policy_version text not null default 'hxos-price-book-v1',
  add column if not exists automation_evidence_state text not null default 'CONTROLLED_TEST_ONLY',
  add column if not exists completed_paid_task_count integer not null default 0,
  add column if not exists calibrated_at timestamptz,
  add column if not exists calibration_evidence_ref text,
  add column if not exists same_day_premium_bps integer not null default 1000,
  add column if not exists market_anchor_zip text not null default '98052',
  add column if not exists included_travel_miles numeric(6,2) not null default 5,
  add column if not exists travel_premium_cents_per_mile integer not null default 100,
  add column if not exists equipment_premium_cents integer not null default 250,
  add column if not exists cargo_vehicle_premium_cents integer not null default 1500,
  add column if not exists scope_addon_premium_cents integer not null default 1000;

-- ============================================================================
-- PRICE BOOK SAFETY CONTRACT
-- ============================================================================

alter table public.price_book
  drop constraint if exists price_book_hxos_policy_version_check,
  add constraint price_book_hxos_policy_version_check
    check (policy_version ~ '^hxos-price-book-v[0-9]+$'),

  drop constraint if exists price_book_automation_evidence_state_check,
  add constraint price_book_automation_evidence_state_check
    check (
      automation_evidence_state
        in ('CONTROLLED_TEST_ONLY', 'CALIBRATED')
    ),

  drop constraint if exists price_book_calibration_evidence_check,
  add constraint price_book_calibration_evidence_check
    check (
      completed_paid_task_count >= 0
      and (
        automation_evidence_state = 'CONTROLLED_TEST_ONLY'
        or (
          automation_evidence_state = 'CALIBRATED'
          and completed_paid_task_count >= 20
          and calibrated_at is not null
          and nullif(btrim(calibration_evidence_ref), '') is not null
        )
      )
    ),

  drop constraint if exists price_book_corridor_economics_check,
  add constraint price_book_corridor_economics_check
    check (
      price_min_cents > 0
      and base_price_cents between price_min_cents and price_max_cents
      and price_max_cents <= price_cap_cents
      and min_hustler_payout_cents * 100
          <= price_min_cents * (100 - platform_margin_floor_pct)
    ),

  drop constraint if exists price_book_deterministic_modifier_check,
  add constraint price_book_deterministic_modifier_check
    check (
      same_day_premium_bps between 0 and 2500
      and market_anchor_zip ~ '^[0-9]{5}$'
      and included_travel_miles between 0 and 50
      and travel_premium_cents_per_mile between 0 and 5000
      and equipment_premium_cents between 0 and 50000
      and cargo_vehicle_premium_cents between 0 and 100000
      and scope_addon_premium_cents between 0 and 100000
    );

-- Normalize any historical rows that violate their own payout/margin floor.
update public.price_book
set
  price_min_cents = greatest(
    price_min_cents,
    ceil(
      min_hustler_payout_cents::numeric
      / (1 - platform_margin_floor_pct::numeric / 100)
    )::integer
  ),
  updated_at = now()
where platform_margin_floor_pct < 100;

-- ============================================================================
-- COARSE ZIP DISTANCE
-- Exact addresses are intentionally excluded from pricing.
-- ============================================================================

create or replace function public.task_supply_zip_distance_miles_v1(
  p_a text,
  p_b text
)
returns numeric
language sql
immutable
set search_path = pg_catalog, public
as $fn$
  with points(zip, lat, lon) as (
    values
      ('98004', 47.6101, -122.2015),
      ('98005', 47.6150, -122.1686),
      ('98006', 47.5579, -122.1541),
      ('98007', 47.6173, -122.1422),
      ('98008', 47.6051, -122.1162),
      ('98011', 47.7592, -122.2054),
      ('98024', 47.5668, -121.8883),
      ('98027', 47.5276, -122.0340),
      ('98029', 47.5570, -121.9990),
      ('98033', 47.6757, -122.1937),
      ('98034', 47.7204, -122.2070),
      ('98052', 47.6739, -122.1230),
      ('98053', 47.6697, -121.9960),
      ('98074', 47.6223, -122.0457),
      ('98075', 47.5861, -122.0409)
  ),
  pair as (
    select
      a.lat as a_lat,
      a.lon as a_lon,
      b.lat as b_lat,
      b.lon as b_lon
    from points a
    cross join points b
    where a.zip = left(coalesce(p_a, ''), 5)
      and b.zip = left(coalesce(p_b, ''), 5)
  )
  select round(
    sqrt(
      power((a_lat - b_lat) * 69.0, 2)
      + power((a_lon - b_lon) * 47.0, 2)
    )::numeric,
    2
  )
  from pair;
$fn$;

-- ============================================================================
-- EASTSIDE SEATTLE PRICE BOOK
-- Exact normalized rows from the supplied Supabase Price Book seed.
-- ============================================================================

insert into public.price_book (
  category,
  service_area,
  base_price_cents,
  price_min_cents,
  price_max_cents,
  min_hustler_payout_cents,
  labor_hours_band,
  platform_margin_floor_pct,
  price_cap_cents,
  allowed_risk_tier,
  min_trust_tier,
  quote_expires_hours,
  dispatch_expires_hours_before_window,
  refund_policy_version,
  active
)
values
    ('furniture_assembly','eastside_seattle',12000,9334,20000,7000,'0.75-2.5h',25,30000,'green',2,72,2,'v1',true),
    ('light_hauling','eastside_seattle',15000,10667,25000,8000,'1-3h',25,40000,'green',0,72,2,'v1',true),
    ('moving','eastside_seattle',20000,13334,30000,10000,'1.5-4h',25,60000,'green',0,72,2,'v1',true),
    ('mowing','eastside_seattle',10000,8000,15000,6000,'0.5-1.5h',25,25000,'green',0,72,2,'v1',true),
    ('pressure_washing','eastside_seattle',22000,14667,35000,11000,'1-3h',25,50000,'green',0,72,2,'v1',true),
    ('yard','eastside_seattle',18000,12000,35000,9000,'1-3.5h',25,50000,'green',0,72,2,'v1',true)
on conflict (category) do update set
  service_area = excluded.service_area,
  base_price_cents = excluded.base_price_cents,
  price_min_cents = excluded.price_min_cents,
  price_max_cents = excluded.price_max_cents,
  min_hustler_payout_cents = excluded.min_hustler_payout_cents,
  labor_hours_band = excluded.labor_hours_band,
  platform_margin_floor_pct = excluded.platform_margin_floor_pct,
  price_cap_cents = excluded.price_cap_cents,
  allowed_risk_tier = excluded.allowed_risk_tier,
  min_trust_tier = excluded.min_trust_tier,
  quote_expires_hours = excluded.quote_expires_hours,
  dispatch_expires_hours_before_window =
    excluded.dispatch_expires_hours_before_window,
  refund_policy_version = excluded.refund_policy_version,
  active = excluded.active,
  updated_at = now();

comment on table public.price_book is
  'Versioned deterministic pricing authority. Unsupported categories are intentionally absent and cannot be auto-quoted.';

commit;