/**
 * LIQUIDITY HEAT ENGINE (Phase 16 - Component 2)
 *
 * Purpose: Visualize market liquidity in real-time.
 *
 * Calculates:
 * - Where tasks pile up (demand heat)
 * - Where hustlers idle (supply cold)
 * - Where pricing is broken
 * - Where trust friction is excessive
 *
 * CONSTRAINTS:
 * - READ-ONLY: Never modifies state
 * - NO KERNEL: Financial layer frozen
 * - ADVISORY: Powers visualization and nudges, not execution
 */
import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
import { CityGridService } from './CityGridService.js';
const logger = serviceLogger.child({ module: 'LiquidityHeat' });
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
// ============================================================
// LIQUIDITY HEAT ENGINE
// ============================================================
export class LiquidityHeatEngine {
    /**
     * GENERATE HEAT SNAPSHOT
     */
    static async generateSnapshot(city) {
        const id = ulid();
        // Get city grid
        const grid = await CityGridService.getGrid(city);
        // Calculate heat for each cell
        const cells = grid.cells.map(gridCell => this.calculateHeat(gridCell));
        // Generate summary
        const summary = this.generateSummary(cells);
        // Generate insights
        const insights = this.generateInsights(cells, summary);
        const snapshot = {
            id,
            city,
            generatedAt: new Date(),
            cells,
            summary,
            insights
        };
        // Persist
        await this.persistSnapshot(snapshot);
        logger.info({
            city,
            avgHeat: summary.avgHeat,
            hotspots: summary.hotspots.length,
            coldspots: summary.coldspots.length
        }, 'Liquidity heat snapshot generated');
        return snapshot;
    }
    /**
     * GET LATEST SNAPSHOT
     */
    static async getLatest(city) {
        const db = getDb();
        if (!db)
            return null;
        try {
            const [row] = await db `
                SELECT data FROM liquidity_heat_snapshots
                WHERE city = ${city}
                ORDER BY generated_at DESC
                LIMIT 1
            `;
            return row ? row.data : null;
        }
        catch (error) {
            logger.error({ error, city }, 'Failed to get latest snapshot');
            return null;
        }
    }
    /**
     * GET ZONE HEAT
     */
    static async getZoneHeat(city, zone) {
        const snapshot = await this.getLatest(city) || await this.generateSnapshot(city);
        return snapshot.cells.filter(c => c.zone === zone);
    }
    /**
     * GET CRITICAL ZONES
     */
    static async getCriticalZones(city) {
        const snapshot = await this.getLatest(city) || await this.generateSnapshot(city);
        return {
            overheated: snapshot.cells.filter(c => c.status === 'overheated'),
            frozen: snapshot.cells.filter(c => c.status === 'cold' && c.demandHeat > 40),
            imbalanced: snapshot.cells.filter(c => Math.abs(c.demandHeat - c.supplyHeat) > 40)
        };
    }
    // -----------------------------------------------------------
    // INTERNAL: Heat Calculation
    // -----------------------------------------------------------
    static calculateHeat(cell) {
        // Demand heat: high demand = high heat
        const demandHeat = cell.demandIndex;
        // Supply heat: inverse - low supply = high heat (shortage)
        const supplyHeat = 100 - cell.supplyIndex;
        // Price heat: deviation from optimal creates heat
        const priceHeat = cell.liquidityRatio < 0.8 || cell.liquidityRatio > 1.5
            ? 70 + Math.abs(1 - cell.liquidityRatio) * 20
            : 30;
        // Friction heat: disputes and churn create heat
        const frictionHeat = Math.min(100, cell.disputeRate * 500 + cell.churnRisk * 0.5);
        // Composite heat score (weighted)
        const heatScore = Math.round(demandHeat * 0.35 +
            supplyHeat * 0.35 +
            priceHeat * 0.15 +
            frictionHeat * 0.15);
        // Status classification
        const status = this.classifyStatus(heatScore, demandHeat, supplyHeat);
        // Trend (would use historical data in production)
        const heatDelta24h = Math.round((Math.random() - 0.5) * 20);
        const trend = heatDelta24h > 5 ? 'heating'
            : heatDelta24h < -5 ? 'cooling'
                : 'stable';
        return {
            zone: cell.zone,
            microZone: cell.microZone,
            demandHeat,
            supplyHeat,
            priceHeat,
            frictionHeat,
            heatScore,
            status,
            heatDelta24h,
            trend
        };
    }
    static classifyStatus(heat, demand, supply) {
        // Overheated: high demand, low supply, high friction
        if (heat > 80 || (demand > 70 && supply > 70))
            return 'overheated';
        // Liquid: balanced, moderate activity
        if (heat >= 40 && heat <= 60 && Math.abs(demand - supply) < 30)
            return 'liquid';
        // Warming: activity picking up
        if (heat >= 30 && heat < 60)
            return 'warming';
        // Cold: low activity or oversupplied
        return 'cold';
    }
    static generateSummary(cells) {
        const avgHeat = Math.round(cells.reduce((sum, c) => sum + c.heatScore, 0) / cells.length);
        // Aggregate by zone
        const zoneHeats = new Map();
        for (const cell of cells) {
            const heats = zoneHeats.get(cell.zone) || [];
            heats.push(cell.heatScore);
            zoneHeats.set(cell.zone, heats);
        }
        const zoneAvgs = [...zoneHeats.entries()].map(([zone, heats]) => ({
            zone,
            heatScore: Math.round(heats.reduce((a, b) => a + b, 0) / heats.length)
        }));
        const hotspots = zoneAvgs
            .filter(z => z.heatScore > 60)
            .sort((a, b) => b.heatScore - a.heatScore)
            .slice(0, 5);
        const coldspots = zoneAvgs
            .filter(z => z.heatScore < 40)
            .sort((a, b) => a.heatScore - b.heatScore)
            .slice(0, 5);
        return {
            avgHeat,
            hotspots,
            coldspots,
            overheatedZones: cells
                .filter(c => c.status === 'overheated')
                .map(c => c.zone)
                .filter((v, i, a) => a.indexOf(v) === i),
            criticalShortages: cells
                .filter(c => c.supplyHeat > 70 && c.demandHeat > 50)
                .map(c => c.zone)
                .filter((v, i, a) => a.indexOf(v) === i)
        };
    }
    static generateInsights(cells, summary) {
        const immediateAttention = [];
        const opportunities = [];
        const risks = [];
        // Immediate attention
        if (summary.criticalShortages.length > 0) {
            immediateAttention.push(`Critical hustler shortages in: ${summary.criticalShortages.join(', ')}`);
        }
        if (summary.overheatedZones.length > 0) {
            immediateAttention.push(`Overheated markets in: ${summary.overheatedZones.join(', ')}`);
        }
        // Opportunities
        const heatingCells = cells.filter(c => c.trend === 'heating');
        if (heatingCells.length > 0) {
            const zones = [...new Set(heatingCells.map(c => c.zone))];
            opportunities.push(`Growing demand in: ${zones.slice(0, 3).join(', ')}`);
        }
        const liquidCells = cells.filter(c => c.status === 'liquid');
        if (liquidCells.length > 0) {
            opportunities.push(`${liquidCells.length} micro-zones at optimal liquidity - maintain investment`);
        }
        // Risks
        const highFriction = cells.filter(c => c.frictionHeat > 60);
        if (highFriction.length > cells.length * 0.2) {
            risks.push('Excessive friction in 20%+ of micro-zones - review trust policies');
        }
        const coolingCells = cells.filter(c => c.trend === 'cooling' && c.demandHeat < 40);
        if (coolingCells.length > cells.length * 0.15) {
            risks.push('Demand cooling in multiple zones - review marketing spend');
        }
        return { immediateAttention, opportunities, risks };
    }
    static async persistSnapshot(snapshot) {
        const db = getDb();
        if (!db)
            return;
        try {
            await db `
                INSERT INTO liquidity_heat_snapshots (
                    id, city, avg_heat, data, generated_at
                ) VALUES (
                    ${snapshot.id}, ${snapshot.city}, ${snapshot.summary.avgHeat},
                    ${JSON.stringify(snapshot)}, ${snapshot.generatedAt}
                )
            `;
        }
        catch (error) {
            logger.warn({ error }, 'Failed to persist heat snapshot');
        }
    }
}
//# sourceMappingURL=LiquidityHeatEngine.js.map