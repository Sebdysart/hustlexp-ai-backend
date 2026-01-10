import { runMigrations } from './schema.js';
import { logger } from '../utils/logger.js';
import process from 'process';
async function main() {
    try {
        logger.info('Starting manual migration...');
        await runMigrations();
        // Optional: seed test data if needed, but not strictly required for this task
        // await seedTestData();
        logger.info('Migration complete.');
        process.exit(0);
    }
    catch (err) {
        logger.error({ err }, 'Migration failed');
        process.exit(1);
    }
}
main();
//# sourceMappingURL=migrate.js.map