/**
 * Incident Report Generator v1.0.0
 *
 * Weekly aggregation of incident events:
 * - Most common incident types
 * - MTTD (Mean Time To Detect) and MTTR (Mean Time To Resolve)
 * - Highest-incident services
 * - Recurring patterns
 *
 * Run via: npm run incident-report
 */

import { db } from '../src/db';

interface IncidentStats {
  totalIncidents: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  resolvedCount: number;
  unresolvedCount: number;
  avgResolutionTimeMinutes: number;
  byType: Record<string, number>;
  byService: Record<string, number>;
  topServices: Array<{ service: string; count: number }>;
}

async function generateReport(days: number = 7): Promise<IncidentStats> {
  // Overall stats
  const overallResult = await db.query<{
    total: string;
    critical_count: string;
    warning_count: string;
    info_count: string;
    resolved_count: string;
    avg_resolution_minutes: string;
  }>(
    `SELECT 
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE severity = 'critical') as critical_count,
       COUNT(*) FILTER (WHERE severity = 'warning') as warning_count,
       COUNT(*) FILTER (WHERE severity = 'info') as info_count,
       COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) as resolved_count,
       AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60) FILTER (WHERE resolved_at IS NOT NULL) as avg_resolution_minutes
     FROM incident_events
     WHERE created_at >= NOW() - INTERVAL '${days} days'`,
    []
  );

  const overall = overallResult.rows[0];
  const total = parseInt(overall.total);

  // By type
  const byTypeResult = await db.query<{ event_type: string; count: string }>(
    `SELECT event_type, COUNT(*) as count
     FROM incident_events
     WHERE created_at >= NOW() - INTERVAL '${days} days'
     GROUP BY event_type
     ORDER BY count DESC`,
    []
  );

  const byType: Record<string, number> = {};
  byTypeResult.rows.forEach(row => {
    byType[row.event_type] = parseInt(row.count);
  });

  // By service
  const byServiceResult = await db.query<{ service: string; count: string }>(
    `SELECT service, COUNT(*) as count
     FROM incident_events
     WHERE created_at >= NOW() - INTERVAL '${days} days'
     GROUP BY service
     ORDER BY count DESC
     LIMIT 10`,
    []
  );

  const byService: Record<string, number> = {};
  const topServices: Array<{ service: string; count: number }> = [];

  byServiceResult.rows.forEach(row => {
    const count = parseInt(row.count);
    byService[row.service] = count;
    topServices.push({ service: row.service, count });
  });

  return {
    totalIncidents: total,
    criticalCount: parseInt(overall.critical_count),
    warningCount: parseInt(overall.warning_count),
    infoCount: parseInt(overall.info_count),
    resolvedCount: parseInt(overall.resolved_count),
    unresolvedCount: total - parseInt(overall.resolved_count),
    avgResolutionTimeMinutes: parseFloat(overall.avg_resolution_minutes || '0'),
    byType,
    byService,
    topServices,
  };
}

async function main() {
  const days = parseInt(process.argv[2] || '7');

  console.log(`===== INCIDENT INTELLIGENCE REPORT (Last ${days} Days) =====\n`);

  const stats = await generateReport(days);

  console.log('📊 Overall Statistics:');
  console.log(`  Total Incidents: ${stats.totalIncidents}`);
  console.log(`  Critical: ${stats.criticalCount} | Warning: ${stats.warningCount} | Info: ${stats.infoCount}`);
  console.log(`  Resolved: ${stats.resolvedCount} | Unresolved: ${stats.unresolvedCount}`);
  console.log(`  Avg Resolution Time: ${stats.avgResolutionTimeMinutes.toFixed(1)} minutes\n`);

  console.log('🔍 Incidents by Type:');
  Object.entries(stats.byType)
    .sort(([, a], [, b]) => b - a)
    .forEach(([type, count]) => {
      const pct = ((count / stats.totalIncidents) * 100).toFixed(1);
      console.log(`  ${type.padEnd(25)} ${count.toString().padStart(4)} (${pct}%)`);
    });
  console.log();

  console.log('🏢 Top Services by Incident Count:');
  stats.topServices.forEach((item, idx) => {
    const pct = ((item.count / stats.totalIncidents) * 100).toFixed(1);
    console.log(`  ${(idx + 1).toString().padStart(2)}. ${item.service.padEnd(20)} ${item.count.toString().padStart(4)} (${pct}%)`);
  });
  console.log();

  // Recommendations
  console.log('💡 Recommendations:');
  if (stats.unresolvedCount > stats.totalIncidents * 0.2) {
    console.log(`  ⚠️  High unresolved rate (${((stats.unresolvedCount / stats.totalIncidents) * 100).toFixed(1)}%) - consider increasing response capacity`);
  }
  if (stats.criticalCount > stats.totalIncidents * 0.3) {
    console.log(`  🚨 High critical incident rate (${((stats.criticalCount / stats.totalIncidents) * 100).toFixed(1)}%) - review alerting thresholds`);
  }
  if (stats.avgResolutionTimeMinutes > 60) {
    console.log(`  ⏱️  MTTR exceeds 60 minutes - consider automation improvements`);
  }

  const topIncidentType = Object.entries(stats.byType).sort(([, a], [, b]) => b - a)[0];
  if (topIncidentType && topIncidentType[1] > stats.totalIncidents * 0.4) {
    console.log(`  🔁 Recurring pattern detected: ${topIncidentType[0]} accounts for ${((topIncidentType[1] / stats.totalIncidents) * 100).toFixed(1)}% of incidents`);
  }

  console.log();
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Report generation failed:', err);
      process.exit(1);
    });
}
