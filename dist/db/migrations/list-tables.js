import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
dotenv.config();
async function main() {
    const sql = neon(process.env.DATABASE_URL);
    const tables = await sql `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
    console.log('PRODUCTION TABLES (' + tables.length + '):');
    tables.forEach((t) => console.log('  ' + t.table_name));
}
main();
//# sourceMappingURL=list-tables.js.map