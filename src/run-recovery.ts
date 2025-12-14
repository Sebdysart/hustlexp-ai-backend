#!/usr/bin/env npx tsx
import './config/env.js';
import { RecoveryEngine } from './infra/recovery/RecoveryEngine.js';

console.log('Running RecoveryEngine...');
RecoveryEngine.runCycle().then(() => {
    console.log('Recovery cycle complete');
    process.exit(0);
});
