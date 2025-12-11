
import { sql } from '../src/db/index.js';
import 'dotenv/config';

async function fixAdminRole() {
    console.log('Checking test-admin-001 role...');

    // Check by firebase_uid
    const users = await sql`SELECT * FROM users WHERE firebase_uid = 'test-admin-001'`;

    if (users.length === 0) {
        console.log('User with firebase_uid=test-admin-001 not found. Creating it...');
        // Let ID act as default (UUID)
        await sql`
            INSERT INTO users (firebase_uid, email, role, name, created_at, updated_at)
            VALUES ('test-admin-001', 'admin_test@hustlexp.com', 'admin', 'Test Admin', NOW(), NOW())
        `;
        console.log('Created user test-admin-001 with role admin');
    } else {
        console.log('Found user:', users[0].id, 'Role:', users[0].role);
        if (users[0].role !== 'admin') {
            await sql`UPDATE users SET role = 'admin' WHERE firebase_uid = 'test-admin-001'`;
            console.log('Updated role to admin');
        } else {
            console.log('Role is already admin');
        }
    }
    process.exit(0);
}

fixAdminRole().catch(console.error);
