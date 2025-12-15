
import Stripe from 'stripe';

async function check() {
    const key = process.env.STRIPE_SECRET_KEY;

    if (!key) {
        console.log(JSON.stringify({ keyValid: false, error: 'No STRIPE_SECRET_KEY found' }));
        return;
    }

    if (!key.startsWith('sk_test_')) {
        console.log(JSON.stringify({ keyValid: false, error: 'Key is not a Test Mode key (must start with sk_test_)' }));
        return;
    }

    try {
        const stripe = new Stripe(key, { apiVersion: '2024-11-20.acacia' as any }); // Using a generally compatible version for check

        // 1. Verify Platform Account
        const account = await stripe.accounts.retrieve();

        console.log(JSON.stringify({
            keyValid: true,
            chargesEnabled: account.charges_enabled,
            transfersEnabled: account.capabilities?.transfers === 'active' || account.payouts_enabled,
            payoutsEnabled: account.payouts_enabled,
            accountId: account.id,
            mode: 'test'
        }, null, 2));

    } catch (error: any) {
        console.log(JSON.stringify({
            keyValid: false,
            error: error.message
        }, null, 2));
    }
}

check();
