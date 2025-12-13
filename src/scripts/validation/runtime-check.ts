
import { env } from '../../config/env.js';
import { sendVerificationSms } from '../../identity/services/SmsService.js';
import { sendVerificationEmail } from '../../identity/services/EmailService.js';
import { assertPayoutsEnabled } from '../../config/safety.js';

async function run() {
    console.log('--- RUNTIME SAFETY CHECK ---');
    console.log(`Environment: ${env.mode}`);
    console.log(`Stripe Mode: ${env.STRIPE_MODE}`);
    console.log(`Payouts Enabled: ${env.isPayoutsEnabled}`);

    // TEST 3A: SMS Suppression
    console.log('\n[TEST 3A] Attempting SMS Send...');
    try {
        const smsResult = await sendVerificationSms('+15551234567');
        console.log('SMS Result:', JSON.stringify(smsResult));
    } catch (e: any) {
        console.error('SMS Failed Unexpectedly:', e.message);
    }

    // TEST 3B: Email Suppression
    console.log('\n[TEST 3B] Attempting Email Send...');
    try {
        const emailResult = await sendVerificationEmail('test@safety.com', '123456');
        console.log('Email Result:', JSON.stringify(emailResult));
    } catch (e: any) {
        console.error('Email Failed Unexpectedly:', e.message);
    }

    // TEST 4: Payout Block
    console.log('\n[TEST 4] Attempting Payout Assertion...');
    try {
        assertPayoutsEnabled('TEST_SCRIPT');
        console.log('FAIL: Payouts were allowed!');
    } catch (e: any) {
        console.log(`PASS: Payouts blocked with error: "${e.message}"`);
    }
}

run().catch(console.error);
