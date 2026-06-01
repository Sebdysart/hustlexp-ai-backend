/**
 * Geo Router v1.0.0 — C5
 *
 * Public, rate-limited, read-only availability endpoint that returns
 * truthful local marketplace aggregates for a given Eastside ZIP.
 *
 * TRUTHFULNESS INVARIANTS (do not violate without a roadmap update):
 *   1. No fake liquidity. Every count comes from real SQL or is zero.
 *   2. No fabricated samples. completedByCategory is aggregate counts only.
 *   3. No PII. No user_id, email, phone, address, or description selected.
 *   4. No writes. This endpoint is strictly read-only.
 *   5. nearbyHustlerCount is 0 + hustlerSignalAvailable=false for all of C5.
 *      We have no Hustler-proximity signal yet; the field is reserved.
 *   6. k-anonymity: averageTimeToAcceptMinutes is null when N < 3.
 *
 * Rate-limited via the shared 3-layer pattern (_shared/publicRateLimit).
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { checkPublicAnonRateLimit, deriveIpKey } from './_shared/publicRateLimit.js';

const geoLog = logger.child({ router: 'geo' });

// Eastside MVP allow-list. Mirrors the web funnel-form.tsx so the homepage
// and backend agree on which ZIPs the marketplace currently serves.
// Mapping is intentionally static and small — no PostGIS, no ZCTA tables.
const EASTSIDE_ZIP_TO_CITY: Record<string, string> = {
  '98052': 'Redmond',
  '98053': 'Redmond',
  '98074': 'Sammamish',
  '98075': 'Sammamish',
  '98004': 'Bellevue',
  '98005': 'Bellevue',
  '98006': 'Bellevue',
  '98007': 'Bellevue',
  '98008': 'Bellevue',
  '98033': 'Kirkland',
  '98034': 'Kirkland',
  '98027': 'Issaquah',
  '98029': 'Issaquah',
};

const K_ANON_MIN = 3;

const availabilityInput = z.object({
  zip: z.string().regex(/^\d{5}$/),
});

export const geoRouter = router({
  /**
   * Truthful local marketplace aggregate for the given ZIP.
   *
   * Returns zeros + emptyState=true when no real data exists.
   * Throws BAD_REQUEST for unknown / non-Eastside ZIPs (do not silently
   * succeed with zeros — the caller deserves to know the area is outside
   * coverage).
   *
   * EXTERNAL EFFECTS:
   *   - DB writes: no
   *   - Stripe: no
   *   - Paid LLM: no
   *   - PII reads: no (only category/timestamps/aggregates)
   */
  availability: publicProcedure
    .input(availabilityInput)
    .query(async ({ input, ctx }) => {
      const ipKey = deriveIpKey(ctx.req?.headers);
      if (!ipKey) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Unable to identify client. Refresh and try again.',
        });
      }

      // Rate limit BEFORE any DB call.
      await checkPublicAnonRateLimit(ipKey, {
        category: 'geo:availability',
        burstLimit: 5,
        burstWindowSec: 60,
        dailyLimit: 30,
        dailyWindowSec: 86400,
        globalLimit: 2000,
        globalWindowSec: 86400,
        burstMessage:
          "You've checked availability a lot recently. Please wait a minute before trying again.",
        dailyMessage: "You've reached today's availability lookup limit.",
        globalMessage: 'Availability lookups are temporarily unavailable.',
      });

      const city = EASTSIDE_ZIP_TO_CITY[input.zip];
      if (!city) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'HustleXP is not yet available in this ZIP.',
        });
      }

      geoLog.info({ zip: input.zip, city }, 'availability request');

      // Run the three aggregate queries in parallel. Each query selects
      // only category + counts/timestamps — no user identifiers.
      //
      // SCHEMA NOTE (C5.1): the live `tasks` table has no city/zip column —
      // only a free-text `location varchar`. We filter by case-insensitive
      // substring match against the mapped city name. This is intentionally
      // forgiving so that "Bellevue, WA", "Bellevue" and "bellevue" all
      // count, and intentionally conservative so the endpoint degrades to
      // emptyState (zeros) — not fabricated counts — when posters haven't
      // populated location yet. Single $1 param preserves the test
      // contract that every aggregate receives only the city as a
      // parameter.
      //
      // Accept-time was previously computed by joining a `task_assignments`
      // table that does not exist in the live schema. We now use
      // `tasks.accepted_at - tasks.created_at` directly. The k-anonymity
      // guard (N < 3 → null) below is unchanged.
      const [postedRes, completedRes, acceptRes] = await Promise.all([
        db.query<{ category: string; n: string }>(
          `SELECT category, COUNT(*)::TEXT AS n
             FROM tasks
            WHERE location ILIKE '%' || $1 || '%'
              AND created_at > NOW() - INTERVAL '7 days'
            GROUP BY category`,
          [city]
        ),
        db.query<{ category: string; n: string }>(
          `SELECT category, COUNT(*)::TEXT AS n
             FROM tasks
            WHERE location ILIKE '%' || $1 || '%'
              AND state = 'COMPLETED'
              AND completed_at IS NOT NULL
              AND completed_at > NOW() - INTERVAL '30 days'
            GROUP BY category`,
          [city]
        ),
        db.query<{ avg_minutes: string | null; n: string }>(
          `SELECT
             AVG(EXTRACT(EPOCH FROM (accepted_at - created_at)) / 60.0)::TEXT AS avg_minutes,
             COUNT(*)::TEXT AS n
             FROM tasks
            WHERE location ILIKE '%' || $1 || '%'
              AND created_at > NOW() - INTERVAL '30 days'
              AND accepted_at IS NOT NULL
              AND accepted_at >= created_at`,
          [city]
        ),
      ]);

      // Posted last 7 days: total + popular categories (top 3 by count).
      const postedRows = postedRes.rows ?? [];
      const tasksPostedLast7Days = postedRows.reduce(
        (sum, r) => sum + Number(r.n ?? 0),
        0
      );
      const popularCategories = [...postedRows]
        .sort((a, b) => Number(b.n ?? 0) - Number(a.n ?? 0))
        .slice(0, 3)
        .map((r) => r.category);

      // Completed last 30 days: total + per-category map.
      const completedRows = completedRes.rows ?? [];
      const completedByCategory: Record<string, number> = {};
      let completedLast30Days = 0;
      for (const r of completedRows) {
        const n = Number(r.n ?? 0);
        completedByCategory[r.category] = n;
        completedLast30Days += n;
      }

      // Avg time-to-accept: null when fewer than K_ANON_MIN observations.
      const acceptRow = acceptRes.rows?.[0];
      const acceptN = Number(acceptRow?.n ?? 0);
      const avgRaw = acceptRow?.avg_minutes;
      const averageTimeToAcceptMinutes =
        acceptN >= K_ANON_MIN && avgRaw !== null && avgRaw !== undefined
          ? Math.round(Number(avgRaw))
          : null;

      const emptyState =
        tasksPostedLast7Days === 0 && completedLast30Days === 0;

      return {
        zip: input.zip,
        // Reserved field — no Hustler-proximity signal in C5. Web should
        // hide any "Hustlers nearby" UI when hustlerSignalAvailable is false.
        nearbyHustlerCount: 0,
        hustlerSignalAvailable: false,
        tasksPostedLast7Days,
        completedLast30Days,
        completedByCategory,
        averageTimeToAcceptMinutes,
        popularCategories,
        emptyState,
        generatedAt: new Date().toISOString(),
      };
    }),
});
