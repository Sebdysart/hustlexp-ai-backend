#!/usr/bin/env npx tsx
import './config/env.js';
import { PendingTransactionReaper } from './infra/recovery/PendingReaper.js';

async function run() {
    console.log('Running PendingTransactionReaper...');
    const result = await PendingTransactionReaper.reap();
    console.log('Result:', result);

    const remaining = await PendingTransactionReaper.getPendingCount();
    console.log('Remaining pending transactions:', remaining);
}

run().then(() => process.exit(0));
