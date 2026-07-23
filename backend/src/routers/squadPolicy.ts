import { TRPCError } from '@trpc/server';

export const REQUIRED_TRUST_TIER = 4;

export function assertEliteTier(trustTier: number | string): void {
  const tier = typeof trustTier === 'number' ? trustTier : parseInt(trustTier, 10);
  if (!Number.isNaN(tier) && tier >= REQUIRED_TRUST_TIER) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'Squads Mode requires Elite trust tier (Tier 4)',
  });
}

export interface ListTaskRow {
  id: string;
  task_id: string;
  squad_id: string;
  required_workers: number;
  payment_split_mode: string;
  per_worker_payment_cents: number;
  status: string;
  created_at: string;
  t_id: string;
  t_title: string;
  t_description: string;
  t_price: number;
  t_location: string | null;
  t_category: string | null;
  t_state: string;
  t_created_at: string;
  t_updated_at: string;
  accepted_workers: string[];
}

export interface SquadTaskRow {
  id: string;
  squad_id: string;
  task_id: string;
  required_workers: number;
  status: string;
  s_id: string;
}

export interface LeaderboardRow {
  rank: string;
  id: string;
  name: string;
  emoji: string;
  tagline: string | null;
  organizer_name: string;
  status: string;
  total_tasks_completed: number;
  total_earnings_cents: number;
  squad_xp: number;
  squad_level: number;
  average_rating: string;
  max_members: number;
  created_at: string;
  last_active_at: string | null;
  member_count: number;
}
