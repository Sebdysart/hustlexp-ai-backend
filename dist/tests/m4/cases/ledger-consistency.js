export const LedgerConsistencyCase = {
    name: 'Ledger Consistency & Integrity',
    run: async (pool) => {
        // 1. Zero Sum Check Global
        const { rows: driftRows } = await pool.query(`
            SELECT transaction_id, SUM(amount * CASE WHEN direction='debit' THEN 1 ELSE -1 END) as drift
            FROM ledger_entries
            GROUP BY transaction_id
            HAVING SUM(amount * CASE WHEN direction='debit' THEN 1 ELSE -1 END) != 0
        `);
        if (driftRows.length > 0) {
            return { passed: false, error: `Consistency Fail: ${driftRows.length} transactions have drift.`, stats: { corruptedIds: driftRows.map(r => r.transaction_id) } };
        }
        // 2. Cardinality Check (Min 2 entries)
        const { rows: cardRows } = await pool.query(`
            SELECT transaction_id, count(*) as c
            FROM ledger_entries
            GROUP BY transaction_id
            HAVING count(*) < 2
        `);
        if (cardRows.length > 0) {
            return { passed: false, error: `Cardinality Fail: ${cardRows.length} transactions have < 2 entries.` };
        }
        // 3. Orphan Check
        const { rows: orphanRows } = await pool.query(`
            SELECT count(*) as c FROM ledger_entries e
            LEFT JOIN ledger_transactions t ON e.transaction_id = t.id
            WHERE t.id IS NULL
        `);
        if (parseInt(orphanRows[0].c) > 0) {
            return { passed: false, error: `Orphan Fail: ${orphanRows[0].c} entries have no transaction parent.` };
        }
        return { passed: true, durationMs: 0, stats: { checkedTransactions: 'ALL' } };
    }
};
//# sourceMappingURL=ledger-consistency.js.map