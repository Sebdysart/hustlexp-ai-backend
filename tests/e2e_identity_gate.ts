import 'dotenv/config';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcrypt';

// Configuration
const CORE_URL = 'http://localhost:3000';
const MAGIC_CODE = '123456';

// Generate Test User
const TEST_UID = randomUUID();
const TEST_EMAIL = `safety_test_${TEST_UID}@hustlexp.app`;
const TEST_PHONE = '+15550009999';

console.log(`\n🔐 STARTING MERGED IDENTITY VERIFICATION for ${TEST_UID}\n`);

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getContext(uid: string) {
    try {
        const res = await axios.get(`${CORE_URL}/api/onboarding/identity-context/${uid}`);
        return res.data;
    } catch (error: any) {
        console.error('Context fetch failed:', error.message);
        throw error;
    }
}

(async () => {
    let sql;
    try {
        // ==========================================
        // STEP 0: CONNECT TO DB
        // ==========================================
        if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing in .env');
        sql = neon(process.env.DATABASE_URL as string);

        // ==========================================
        // STEP 1: CREATE USER IN CORE
        // ==========================================
        console.log('1️⃣  Creating User in Core DB...');
        await sql`
            INSERT INTO users (id, email, name, firebase_uid, role)
            VALUES (${TEST_UID}::uuid, ${TEST_EMAIL}, 'Merge Test User', ${`firebase_${TEST_UID}`}, 'hustler')
            ON CONFLICT (id) DO NOTHING
        `;
        console.log('   ✅ User seeded.');

        // Verify initial context
        console.log('   Checking Identity Context (Expect New/High)...');
        let ctx = await getContext(TEST_UID);
        if (ctx.trustTier !== 'new' || ctx.riskLevel !== 'high') {
            throw new Error(`FAIL: Expected 'new'/'high', got ${ctx.trustTier}/${ctx.riskLevel}`);
        }
        console.log('   ✅ PASS: Initial state correct.');

        // ==========================================
        // STEP 2: VERIFY EMAIL
        // ==========================================
        console.log('\n2️⃣  Verifying Email (API -> Service -> DB -> EventBus)...');

        // A. Request Code
        console.log('   -> Requesting Email Code...');
        await axios.post(`${CORE_URL}/identity/email/send`, { userId: TEST_UID, email: TEST_EMAIL });

        // B. Inject Known Hash (Whitebox Hack)
        console.log('   -> Injecting Magic Hash into DB...');
        const magicHash = await bcrypt.hash(MAGIC_CODE, 10);
        await sql`
            UPDATE verification_attempts 
            SET code_hash = ${magicHash}
            WHERE user_id = ${TEST_UID}::uuid AND channel = 'email'
        `;

        // C. Verify Code
        console.log('   -> Verifying via API...');
        await axios.post(`${CORE_URL}/identity/email/verify`, {
            userId: TEST_UID,
            email: TEST_EMAIL,
            code: MAGIC_CODE
        });

        // D. Check State
        await sleep(500); // Allow EventBus
        ctx = await getContext(TEST_UID);

        if (!ctx.identity.emailVerified) {
            throw new Error('FAIL: User email not verified in context');
        }
        console.log('   ✅ PASS: Email verified via API.');

        // ==========================================
        // STEP 3: VERIFY PHONE
        // ==========================================
        console.log('\n3️⃣  Verifying Phone...');

        // A. Request Code
        console.log('   -> Requesting SMS Code...');
        await axios.post(`${CORE_URL}/identity/phone/send`, { userId: TEST_UID, phone: TEST_PHONE });

        // B. Inject Known Hash
        console.log('   -> Injecting Magic Hash into DB...');
        await sql`
            UPDATE verification_attempts 
            SET code_hash = ${magicHash}
            WHERE user_id = ${TEST_UID}::uuid AND channel = 'sms'
        `;

        // C. Verify Code
        console.log('   -> Verifying via API...');
        await axios.post(`${CORE_URL}/identity/phone/verify`, {
            userId: TEST_UID,
            phone: TEST_PHONE,
            code: MAGIC_CODE
        });

        // ==========================================
        // STEP 4: FINAL ASSERTION
        // ==========================================
        console.log('\n4️⃣  Checking Final Safety Lock State...');
        await sleep(1000); // Allow fully_verified event propagation
        ctx = await getContext(TEST_UID);

        if (!ctx.identity.phoneVerified) {
            throw new Error('FAIL: Phone not verified');
        }
        if (ctx.trustTier !== 'verified') {
            throw new Error(`FAIL: Expected 'verified', got '${ctx.trustTier}'`);
        }
        if (!ctx.identity.isFullyVerified) {
            throw new Error('FAIL: isFullyVerified is false');
        }

        console.log('   ✅ PASS: Trust Tier is "verified".');
        console.log('   ✅ PASS: onBoarding unlocked.');
        console.log('\n🏆 MERGE SUCCESSFUL: IVS Logic is Fully Functional Inside Core Backend.');

    } catch (error: any) {
        console.error('\n❌ FATAL ERROR:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', JSON.stringify(error.response.data));
        }
        process.exit(1);
    }
})();
