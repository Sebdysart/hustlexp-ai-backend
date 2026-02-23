/**
 * Weekly Incident Report Generator
 *
 * Queries incident_events for the last 7 days and outputs a markdown report to stdout.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/generate-incident-report.ts
 */

import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

interface IncidentRow {
  id: string;
  event_type: string;
  severity: string;
  service: string;
  resolved_at: string | null;
  created_at: string;
}

interface ServiceSummary {
  service: string;
  count: number;
  most_common_type: string;
}

async function main() {
  try {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    // Fetch all incidents from last 7 days
    const incidentsResult = await pool.query<IncidentRow>(
      `SELECT id, event_type, severity, service, resolved_at, created_at
       FROM incident_events
       WHERE created_at >= $1
       ORDER BY created_at DESC`,
      [weekAgo.toISOString()]
    );

    const incidents = incidentsResult.rows;
    const total = incidents.length;

    // Count by severity
    const critical = incidents.filter((i) => i.severity === 'critical').length;
    const warning = incidents.filter((i) => i.severity === 'warning').length;
    const info = incidents.filter((i) => i.severity === 'info').length;

    // Count resolved/unresolved
    const resolved = incidents.filter((i) => i.resolved_at !== null).length;
    const unresolved = incidents.filter((i) => i.resolved_at === null).length;

    // By service aggregation
    const serviceMap = new Map<string, { count: number; types: Map<string, number> }>();
    for (const incident of incidents) {
      const entry = serviceMap.get(incident.service) || { count: 0, types: new Map() };
      entry.count++;
      entry.types.set(incident.event_type, (entry.types.get(incident.event_type) || 0) + 1);
      serviceMap.set(incident.service, entry);
    }

    const serviceSummaries: ServiceSummary[] = [];
    for (const [service, data] of serviceMap) {
      let mostCommonType = '';
      let maxCount = 0;
      for (const [type, count] of data.types) {
        if (count > maxCount) {
          mostCommonType = type;
          maxCount = count;
        }
      }
      serviceSummaries.push({ service, count: data.count, most_common_type: mostCommonType });
    }
    serviceSummaries.sort((a, b) => b.count - a.count);

    // Unresolved incidents
    const unresolvedIncidents = incidents.filter((i) => i.resolved_at === null);

    // Pattern detection
    const typeCounts = new Map<string, number>();
    for (const incident of incidents) {
      typeCounts.set(incident.event_type, (typeCounts.get(incident.event_type) || 0) + 1);
    }
    let mostCommonType = '';
    let mostCommonCount = 0;
    for (const [type, count] of typeCounts) {
      if (count > mostCommonCount) {
        mostCommonType = type;
        mostCommonCount = count;
      }
    }

    // Find highest-severity service
    let highestSeverityService = 'none';
    const criticalByService = new Map<string, number>();
    for (const incident of incidents) {
      if (incident.severity === 'critical') {
        criticalByService.set(incident.service, (criticalByService.get(incident.service) || 0) + 1);
      }
    }
    let maxCritical = 0;
    for (const [service, count] of criticalByService) {
      if (count > maxCritical) {
        highestSeverityService = service;
        maxCritical = count;
      }
    }

    // Format date
    const weekOfDate = weekAgo.toISOString().split('T')[0];

    // Output markdown
    const output = `# Incident Report — Week of ${weekOfDate}

## Summary
- Total incidents: ${total}
- Critical: ${critical} | Warning: ${warning} | Info: ${info}
- Resolved: ${resolved} | Unresolved: ${unresolved}

## By Service
| Service | Count | Most Common Type |
|---------|-------|-----------------|
${serviceSummaries.length > 0 ? serviceSummaries.map((s) => `| ${s.service} | ${s.count} | ${s.most_common_type} |`).join('\n') : '| (none) | 0 | - |'}

## Unresolved Incidents
| ID | Type | Severity | Service | Created |
|----|------|----------|---------|---------|
${unresolvedIncidents.length > 0 ? unresolvedIncidents.map((i) => `| ${i.id.slice(0, 8)}... | ${i.event_type} | ${i.severity} | ${i.service} | ${i.created_at} |`).join('\n') : '| (none) | - | - | - | - |'}

## Patterns
- Most common: ${mostCommonType || 'none'} (${mostCommonCount} occurrences)
- Highest severity service: ${highestSeverityService}
`;

    console.log(output);
  } catch (error) {
    console.error('Failed to generate report:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
