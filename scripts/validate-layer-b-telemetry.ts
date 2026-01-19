/**
 * Layer B - End-to-End Smoke Test Validation
 * 
 * Validates telemetry data from RN app execution.
 * Run after manually testing E1/E2/E3 screens in the RN app.
 */

import { db } from '../backend/src/db';
import { trpc } from '../backend/src/routers';

async function validateLayerB() {
  console.log('📊 Layer B - End-to-End Smoke Test Validation\n');
  console.log('='.repeat(60));

  const results: Record<string, { pass: boolean; notes: string }> = {};

  try {
    // Scenario 1: E1 - No Tasks Available
    console.log('\n📋 Scenario 1: E1 - No Tasks Available');
    const e1Impression = await db.query(`
      SELECT COUNT(*) as count, 
             AVG(time_on_screen_ms) as avg_time,
             COUNT(DISTINCT user_id) as unique_users
      FROM alpha_telemetry
      WHERE event_group = 'edge_state_impression'
        AND state = 'E1_NO_TASKS_AVAILABLE'
        AND timestamp > NOW() - INTERVAL '1 hour'
    `);

    const e1Exit = await db.query(`
      SELECT COUNT(*) as count,
             AVG(time_on_screen_ms) as avg_time
      FROM alpha_telemetry
      WHERE event_group = 'edge_state_exit'
        AND state = 'E1_NO_TASKS_AVAILABLE'
        AND timestamp > NOW() - INTERVAL '1 hour'
    `);

    const e1ImpressionCount = parseInt(e1Impression.rows[0]?.count || '0', 10);
    const e1ExitCount = parseInt(e1Exit.rows[0]?.count || '0', 10);
    const e1AvgTime = parseFloat(e1Exit.rows[0]?.avg_time || '0');

    const e1Pass = e1ImpressionCount > 0 && e1ExitCount > 0 && e1AvgTime >= 250;
    results.E1 = {
      pass: e1Pass,
      notes: e1Pass 
        ? `Impression: ${e1ImpressionCount}, Exit: ${e1ExitCount}, Avg time: ${Math.round(e1AvgTime)}ms`
        : `Missing events or invalid duration (impression: ${e1ImpressionCount}, exit: ${e1ExitCount}, avg: ${e1AvgTime}ms)`
    };

    // Scenario 2: E2 - Eligibility Mismatch
    console.log('\n📋 Scenario 2: E2 - Eligibility Mismatch');
    const e2Impression = await db.query(`
      SELECT COUNT(*) as count,
             COUNT(DISTINCT user_id) as unique_users
      FROM alpha_telemetry
      WHERE event_group = 'edge_state_impression'
        AND state = 'E2_ELIGIBILITY_MISMATCH'
        AND timestamp > NOW() - INTERVAL '1 hour'
    `);

    const e2Exit = await db.query(`
      SELECT COUNT(*) as count
      FROM alpha_telemetry
      WHERE event_group = 'edge_state_exit'
        AND state = 'E2_ELIGIBILITY_MISMATCH'
        AND timestamp > NOW() - INTERVAL '1 hour'
    `);

    const e2ImpressionCount = parseInt(e2Impression.rows[0]?.count || '0', 10);
    const e2ExitCount = parseInt(e2Exit.rows[0]?.count || '0', 10);
    const e2DuplicateCheck = e2ImpressionCount === e2ExitCount;

    const e2Pass = e2ImpressionCount > 0 && e2ExitCount > 0 && e2DuplicateCheck;
    results.E2 = {
      pass: e2Pass,
      notes: e2Pass
        ? `Impression: ${e2ImpressionCount}, Exit: ${e2ExitCount}, Paired correctly`
        : `Missing events or unparied (impression: ${e2ImpressionCount}, exit: ${e2ExitCount})`
    };

    // Scenario 3: E3 - Trust Tier Locked
    console.log('\n📋 Scenario 3: E3 - Trust Tier Locked');
    const e3Impression = await db.query(`
      SELECT COUNT(*) as count
      FROM alpha_telemetry
      WHERE event_group = 'edge_state_impression'
        AND state = 'E3_TRUST_TIER_LOCKED'
        AND timestamp > NOW() - INTERVAL '1 hour'
    `);

    const e3Exit = await db.query(`
      SELECT exit_type, COUNT(*) as count
      FROM alpha_telemetry
      WHERE event_group = 'edge_state_exit'
        AND state = 'E3_TRUST_TIER_LOCKED'
        AND timestamp > NOW() - INTERVAL '1 hour'
      GROUP BY exit_type
    `);

    const e3ImpressionCount = parseInt(e3Impression.rows[0]?.count || '0', 10);
    const e3ExitCount = e3Exit.rows.reduce((sum, r) => sum + parseInt(r.count || '0', 10), 0);
    const e3ExitTypes = e3Exit.rows.map(r => r.exit_type).filter(Boolean);

    const e3Pass = e3ImpressionCount > 0 && e3ExitCount > 0 && e3ExitTypes.every(t => ['continue', 'back'].includes(t));
    results.E3 = {
      pass: e3Pass,
      notes: e3Pass
        ? `Impression: ${e3ImpressionCount}, Exit: ${e3ExitCount}, Exit types: ${e3ExitTypes.join(', ')}`
        : `Missing events or invalid exit types (impression: ${e3ImpressionCount}, exit: ${e3ExitCount}, types: ${e3ExitTypes.join(', ')})`
    };

    // Scenario 4: Trust Delta Emission
    console.log('\n📋 Scenario 4: Trust Delta Emission');
    const trustDeltas = await db.query(`
      SELECT delta_type, COUNT(*) as count,
             COUNT(DISTINCT task_id) FILTER (WHERE task_id IS NOT NULL) as xp_tasks,
             AVG(delta_amount) as avg_delta
      FROM alpha_telemetry
      WHERE event_group = 'trust_delta_applied'
        AND timestamp > NOW() - INTERVAL '1 hour'
      GROUP BY delta_type
    `);

    const xpDeltas = trustDeltas.rows.find(r => r.delta_type === 'xp');
    const tierDeltas = trustDeltas.rows.find(r => r.delta_type === 'tier');

    const xpCount = parseInt(xpDeltas?.count || '0', 10);
    const xpTasks = parseInt(xpDeltas?.xp_tasks || '0', 10);
    const tierCount = parseInt(tierDeltas?.count || '0', 10);

    const trustDeltaPass = (xpCount > 0 && xpTasks > 0) || tierCount > 0;
    results.TrustDelta = {
      pass: trustDeltaPass,
      notes: trustDeltaPass
        ? `XP deltas: ${xpCount} (tasks: ${xpTasks}), Tier deltas: ${tierCount}`
        : `No trust deltas found (XP: ${xpCount}, Tier: ${tierCount})`
    };

    // Scenario 5: Negative Path (Silent Failure)
    // Check event-group-specific required fields (not all fields required for all groups)
    console.log('\n📋 Scenario 5: Negative Path (Silent Failure)');
    const malformedImpression = await db.query(`
      SELECT COUNT(*) as count
      FROM alpha_telemetry
      WHERE event_group = 'edge_state_impression'
        AND (state IS NULL OR role IS NULL OR trust_tier IS NULL)
        AND timestamp > NOW() - INTERVAL '1 hour'
    `);

    const malformedExit = await db.query(`
      SELECT COUNT(*) as count
      FROM alpha_telemetry
      WHERE event_group = 'edge_state_exit'
        AND (state IS NULL OR role IS NULL)
        AND timestamp > NOW() - INTERVAL '1 hour'
    `);

    const malformedTrust = await db.query(`
      SELECT COUNT(*) as count
      FROM alpha_telemetry
      WHERE event_group = 'trust_delta_applied'
        AND (role IS NULL OR delta_type IS NULL OR delta_amount IS NULL)
        AND timestamp > NOW() - INTERVAL '1 hour'
    `);

    const malformedImpressionCount = parseInt(malformedImpression.rows[0]?.count || '0', 10);
    const malformedExitCount = parseInt(malformedExit.rows[0]?.count || '0', 10);
    const malformedTrustCount = parseInt(malformedTrust.rows[0]?.count || '0', 10);
    const totalMalformed = malformedImpressionCount + malformedExitCount + malformedTrustCount;

    const negativePathPass = totalMalformed === 0;
    results.NegativePath = {
      pass: negativePathPass,
      notes: negativePathPass
        ? `No malformed events (all required fields present)`
        : `Found ${totalMalformed} malformed events (impression: ${malformedImpressionCount}, exit: ${malformedExitCount}, trust: ${malformedTrustCount})`
    };

    // Dashboard Validation
    console.log('\n📋 Dashboard Validation');
    const dashboardDist = await db.query(`
      SELECT state, COUNT(*) as count
      FROM alpha_telemetry
      WHERE event_group = 'edge_state_impression'
        AND timestamp > NOW() - INTERVAL '1 hour'
      GROUP BY state
    `);

    const dashboardTime = await db.query(`
      SELECT AVG(time_on_screen_ms) as avg_time
      FROM alpha_telemetry
      WHERE event_group = 'edge_state_exit'
        AND timestamp > NOW() - INTERVAL '1 hour'
    `);

    const dashboardTrust = await db.query(`
      SELECT COUNT(*) as count
      FROM alpha_telemetry
      WHERE event_group = 'trust_delta_applied'
        AND timestamp > NOW() - INTERVAL '1 hour'
    `);

    const distValid = dashboardDist.rows.length > 0;
    const timeValid = dashboardTime.rows[0]?.avg_time > 0;
    const trustValid = parseInt(dashboardTrust.rows[0]?.count || '0', 10) >= 0;

    const dashboardPass = distValid && timeValid && trustValid;
    results.Dashboard = {
      pass: dashboardPass,
      notes: dashboardPass
        ? `Distribution: ${dashboardDist.rows.length} states, Avg time: ${Math.round(parseFloat(dashboardTime.rows[0]?.avg_time || '0'))}ms, Trust deltas: ${dashboardTrust.rows[0]?.count}`
        : `Query failures or empty results (dist: ${distValid}, time: ${timeValid}, trust: ${trustValid})`
    };

    // Final Report
    console.log('\n' + '='.repeat(60));
    console.log('Layer B Results');
    console.log('='.repeat(60));

    Object.entries(results).forEach(([scenario, result]) => {
      console.log(`${scenario}: ${result.pass ? 'PASS' : 'FAIL'} — ${result.notes}`);
    });

    const allPassed = Object.values(results).every(r => r.pass);
    console.log('\n' + '='.repeat(60));
    console.log(`Overall: ${allPassed ? '✅ ALL SCENARIOS PASSED' : '❌ ONE OR MORE SCENARIOS FAILED'}`);

    process.exit(allPassed ? 0 : 1);

  } catch (error) {
    console.error('\n❌ Layer B validation ERROR:', error);
    console.error('Stack:', error instanceof Error ? error.stack : 'No stack trace');
    process.exit(1);
  }
}

validateLayerB();
