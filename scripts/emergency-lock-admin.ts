#!/usr/bin/env npx tsx
/**
 * Emergency Admin Lock Script
 * 
 * Immediately blocks an admin UID from accessing admin endpoints,
 * even if they have a valid JWT with admin:true.
 * 
 * Usage:
 *   npx tsx scripts/emergency-lock-admin.ts <uid> <reason>
 * 
 * Example:
 *   npx tsx scripts/emergency-lock-admin.ts test-admin-001 "Account compromised"
 * 
 * This adds the UID to the Redis denylist with no expiry.
 * The UID will remain blocked until manually removed.
 */

import 'dotenv/config';

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    console.error('ERROR: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN required in .env');
    process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 2) {
    console.error('Usage: npx tsx scripts/emergency-lock-admin.ts <uid> <reason>');
    console.error('Example: npx tsx scripts/emergency-lock-admin.ts test-admin-001 "Account compromised"');
    process.exit(1);
}

const uid = args[0];
const reason = args.slice(1).join(' ');

async function emergencyLock() {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  EMERGENCY ADMIN LOCK');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log(`UID: ${uid}`);
    console.log(`Reason: ${reason}`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log('');

    // Use Redis REST API directly (same as @upstash/redis does internally)
    const entry = {
        uid,
        reason: `EMERGENCY LOCK: ${reason}`,
        addedBy: 'emergency-lock-script',
        addedAt: new Date().toISOString(),
        expiresAt: null,
        isEmergency: true,
    };

    try {
        // Set the key (no TTL = permanent)
        const setResponse = await fetch(`${UPSTASH_REDIS_REST_URL}/set/admin:denylist:${uid}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify([JSON.stringify(entry)]),
        });

        if (!setResponse.ok) {
            throw new Error(`Redis SET failed: ${await setResponse.text()}`);
        }

        // Add to the set
        const saddResponse = await fetch(`${UPSTASH_REDIS_REST_URL}/sadd/admin:denylist:uids/${uid}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
            },
        });

        if (!saddResponse.ok) {
            throw new Error(`Redis SADD failed: ${await saddResponse.text()}`);
        }

        console.log('✅ UID LOCKED - Admin access blocked immediately');
        console.log('');
        console.log('The admin will receive HTTP 403 with code: ADMIN_REVOKED');
        console.log('');
        console.log('To unlock, run:');
        console.log(`  npx tsx scripts/unlock-admin.ts ${uid}`);
        console.log('');
        console.log('═══════════════════════════════════════════════════════════════\n');

    } catch (error) {
        console.error('❌ LOCK FAILED:', error);
        process.exit(1);
    }
}

emergencyLock();
