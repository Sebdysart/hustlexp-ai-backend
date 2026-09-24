-- Expo push registrations are separate from legacy native FCM device_tokens.
-- A stable installation identity prevents a rotated token or account switch from
-- leaving the previous account subscribed on the same installed app.
CREATE TABLE IF NOT EXISTS public.mobile_push_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL,
  app_variant TEXT NOT NULL CHECK (app_variant IN ('poster', 'business')),
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  expo_push_token TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_variant, installation_id),
  UNIQUE (expo_push_token)
);

CREATE INDEX IF NOT EXISTS mobile_push_devices_user_variant_active_idx
  ON public.mobile_push_devices (user_id, app_variant) WHERE is_active;

CREATE TABLE IF NOT EXISTS public.mobile_push_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES public.mobile_push_devices(id) ON DELETE CASCADE,
  notification_id UUID REFERENCES public.notifications(id) ON DELETE CASCADE,
  expo_ticket_id TEXT NOT NULL UNIQUE,
  checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mobile_push_receipts_pending_idx
  ON public.mobile_push_receipts (created_at) WHERE checked_at IS NULL;
