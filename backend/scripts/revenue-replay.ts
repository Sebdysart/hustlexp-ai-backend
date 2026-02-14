/**
 * Revenue Replay Script v1.0.0
 *
 * Generates a complete P&L from revenue_ledger alone — no joins to
 * escrows, tasks, or Stripe. Proves the ledger is self-contained.
 *
 * Sprint 2 DONE criteria: "Financial replay script generates P&L"
 *
 * Usage:
 *   npx tsx scripts/revenue-replay.ts
 *   npx tsx scripts/revenue-replay.ts --months 6
 *   npx tsx scripts/revenue-replay.ts --verify
 *
 * Output:
 *   - Monthly P&L breakdown by revenue stream
 *   - GMV through escrow
 *   - Chargeback loss/recovery
 *   - Net revenue
 *   - Integrity check: SUM(gross) - SUM(net) = SUM(platform_fee) for platform_fee events
 */

import pg from 'pg';

// ============================================================================
// CONFIG
// ============================================================================

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable required');
  process.exit(1);
}

const args = process.argv.slice(2);
const monthsArg = args.find(a => a.startsWith('--months'));
const months = monthsArg ? parseInt(args[args.indexOf(monthsArg) + 1] || '12', 10) : 12;
const verifyOnly = args.includes('--verify');

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    console.log('='.repeat(80));
    console.log('HUSTLEXP REVENUE REPLAY — P&L FROM LEDGER ALONE');
    console.log('='.repeat(80));
    console.log(`Period: Last ${months} months`);
    console.log(`Database: ${DATABASE_URL?.replace(/\/\/.*@/, '//<redacted>@')}`);
    console.log('');

    // ========================================================================
    // 1. INTEGRITY CHECK
    // ========================================================================
    console.log('--- INTEGRITY CHECK ---');

    const integrity = await pool.query(`
      SELECT
        COUNT(*) as event_count,
        COALESCE(SUM(gross_amount_cents), 0) as total_gross,
        COALESCE(SUM(net_amount_cents), 0) as total_net,
        COALESCE(SUM(platform_fee_cents), 0) as total_fees
      FROM revenue_ledger
      WHERE event_type = 'platform_fee'
        AND gross_amount_cents IS NOT NULL
    `);

    const intRow = integrity.rows[0];
    const totalGross = parseInt(intRow.total_gross, 10);
    const totalNet = parseInt(intRow.total_net, 10);
    const totalFees = parseInt(intRow.total_fees, 10);
    const grossMinusNet = totalGross - totalNet;
    const delta = grossMinusNet - totalFees;

    console.log(`Platform fee events: ${intRow.event_count}`);
    console.log(`Total gross (GMV): $${(totalGross / 100).toFixed(2)}`);
    console.log(`Total net (worker): $${(totalNet / 100).toFixed(2)}`);
    console.log(`Total fees (ours):  $${(totalFees / 100).toFixed(2)}`);
    console.log(`Gross - Net:        $${(grossMinusNet / 100).toFixed(2)}`);
    console.log(`Delta (should = 0): $${(delta / 100).toFixed(2)}`);
    console.log(`Balanced: ${delta === 0 ? 'YES' : 'NO — MISMATCH DETECTED'}`);
    console.log('');

    // V2 coverage check
    const coverage = await pool.query(`
      SELECT
        event_type,
        COUNT(*) as total,
        COUNT(gross_amount_cents) as has_v2,
        COUNT(*) - COUNT(gross_amount_cents) as missing_v2
      FROM revenue_ledger
      GROUP BY event_type
      ORDER BY event_type
    `);

    console.log('--- V2 COLUMN COVERAGE ---');
    console.log(
      'Event Type'.padEnd(25) +
      'Total'.padStart(8) +
      'Has V2'.padStart(8) +
      'Missing'.padStart(8)
    );
    console.log('-'.repeat(49));
    for (const row of coverage.rows) {
      console.log(
        row.event_type.padEnd(25) +
        row.total.toString().padStart(8) +
        row.has_v2.toString().padStart(8) +
        row.missing_v2.toString().padStart(8)
      );
    }
    console.log('');

    if (verifyOnly) {
      console.log('Verify-only mode. Exiting.');
      return;
    }

    // ========================================================================
    // 2. MONTHLY P&L
    // ========================================================================
    console.log('--- MONTHLY P&L ---');

    const pnl = await pool.query(`
      SELECT
        to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
        currency,
        -- Revenue streams
        SUM(CASE WHEN event_type = 'platform_fee' THEN amount_cents ELSE 0 END) AS platform_fee,
        SUM(CASE WHEN event_type = 'featured_listing' THEN amount_cents ELSE 0 END) AS featured,
        SUM(CASE WHEN event_type = 'skill_verification' THEN amount_cents ELSE 0 END) AS skill_ver,
        SUM(CASE WHEN event_type = 'insurance_premium' THEN amount_cents ELSE 0 END) AS insurance,
        SUM(CASE WHEN event_type = 'subscription' THEN amount_cents ELSE 0 END) AS subscriptions,
        SUM(CASE WHEN event_type = 'per_task_fee' THEN amount_cents ELSE 0 END) AS per_task,
        SUM(CASE WHEN event_type = 'xp_tax' THEN amount_cents ELSE 0 END) AS xp_tax,
        -- Losses
        SUM(CASE WHEN event_type = 'chargeback' THEN amount_cents ELSE 0 END) AS chargebacks,
        SUM(CASE WHEN event_type = 'chargeback_reversal' THEN amount_cents ELSE 0 END) AS recovered,
        SUM(CASE WHEN event_type = 'referral_payout' THEN amount_cents ELSE 0 END) AS referrals,
        -- Totals
        SUM(amount_cents) AS net_revenue,
        COUNT(*) AS events,
        -- GMV
        SUM(CASE WHEN event_type = 'platform_fee' THEN COALESCE(gross_amount_cents, 0) ELSE 0 END) AS gmv,
        -- Disputes
        SUM(CASE WHEN event_type = 'chargeback' THEN 1 ELSE 0 END) AS dispute_count
      FROM revenue_ledger
      WHERE created_at > NOW() - make_interval(months => $1)
      GROUP BY date_trunc('month', created_at), currency
      ORDER BY month DESC
    `, [months]);

    if (pnl.rows.length === 0) {
      console.log('No revenue data found for the specified period.');
    } else {
      for (const row of pnl.rows) {
        console.log(`\n--- ${row.month} (${row.currency.toUpperCase()}) ---`);
        console.log(`  GMV (escrow):       $${(parseInt(row.gmv, 10) / 100).toFixed(2)}`);
        console.log(`  Platform fees:      $${(parseInt(row.platform_fee, 10) / 100).toFixed(2)}`);
        console.log(`  Featured listings:  $${(parseInt(row.featured, 10) / 100).toFixed(2)}`);
        console.log(`  Subscriptions:      $${(parseInt(row.subscriptions, 10) / 100).toFixed(2)}`);
        console.log(`  Skill verification: $${(parseInt(row.skill_ver, 10) / 100).toFixed(2)}`);
        console.log(`  Insurance premiums: $${(parseInt(row.insurance, 10) / 100).toFixed(2)}`);
        console.log(`  Per-task fees:      $${(parseInt(row.per_task, 10) / 100).toFixed(2)}`);
        console.log(`  XP tax:             $${(parseInt(row.xp_tax, 10) / 100).toFixed(2)}`);
        console.log(`  Chargebacks:        $${(parseInt(row.chargebacks, 10) / 100).toFixed(2)}`);
        console.log(`  Recovered:          $${(parseInt(row.recovered, 10) / 100).toFixed(2)}`);
        console.log(`  Referral payouts:   $${(parseInt(row.referrals, 10) / 100).toFixed(2)}`);
        console.log(`  ─────────────────────────────`);
        console.log(`  NET REVENUE:        $${(parseInt(row.net_revenue, 10) / 100).toFixed(2)}`);
        console.log(`  Events:             ${row.events}`);
        console.log(`  Disputes:           ${row.dispute_count}`);
      }
    }

    // ========================================================================
    // 3. LIFETIME TOTALS
    // ========================================================================
    console.log('\n\n--- LIFETIME TOTALS ---');

    const totals = await pool.query(`
      SELECT
        SUM(amount_cents) AS total_net_revenue,
        SUM(CASE WHEN event_type = 'platform_fee' THEN COALESCE(gross_amount_cents, 0) ELSE 0 END) AS total_gmv,
        SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS total_revenue,
        SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END) AS total_losses,
        COUNT(*) AS total_events,
        SUM(CASE WHEN event_type = 'chargeback' THEN 1 ELSE 0 END) AS total_disputes,
        SUM(CASE WHEN event_type = 'chargeback_reversal' THEN 1 ELSE 0 END) AS total_won
      FROM revenue_ledger
    `);

    const t = totals.rows[0];
    const totalRevenue = parseInt(t.total_revenue || '0', 10);
    const totalLosses = parseInt(t.total_losses || '0', 10);
    const netRevenue = parseInt(t.total_net_revenue || '0', 10);
    const totalGMV = parseInt(t.total_gmv || '0', 10);
    const totalDisputes = parseInt(t.total_disputes || '0', 10);
    const totalWon = parseInt(t.total_won || '0', 10);

    console.log(`Total GMV:          $${(totalGMV / 100).toFixed(2)}`);
    console.log(`Total revenue:      $${(totalRevenue / 100).toFixed(2)}`);
    console.log(`Total losses:       $${(totalLosses / 100).toFixed(2)}`);
    console.log(`NET REVENUE:        $${(netRevenue / 100).toFixed(2)}`);
    console.log(`Total events:       ${t.total_events}`);
    console.log(`Total disputes:     ${totalDisputes}`);
    console.log(`Disputes won:       ${totalWon}`);
    if (totalDisputes > 0) {
      console.log(`Win rate:           ${((totalWon / totalDisputes) * 100).toFixed(1)}%`);
    }

    console.log('\n' + '='.repeat(80));
    console.log('REPLAY COMPLETE — Generated from revenue_ledger alone (no escrow/task joins)');
    console.log('='.repeat(80));

  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Revenue replay failed:', err);
  process.exit(1);
});
