/**
 * Evil Test B: Unknown job name in critical_payments queue
 * 
 * This script enqueues a job with name "foo.bar" into critical_payments queue.
 * 
 * Expected behavior:
 * - Worker logs: "Unknown event type in critical_payments queue: foo.bar..."
 * - Job fails (as designed)
 * - PaymentWorker is never invoked
 * 
 * Run with: node scripts/test-evil-b.js
 */

const { Queue } = require('bullmq');
const IORedis = require('ioredis');

(async () => {
  try {
    const connection = new IORedis(process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || 'redis://127.0.0.1:6379');
    const q = new Queue('critical_payments', { connection });
    
    console.log('📤 Enqueuing job with unknown name "foo.bar"...');
    const job = await q.add('foo.bar', { 
      aggregate_type: 'test',
      aggregate_id: 'test-id',
      event_version: 1,
      payload: { hello: 'world' } 
    }, { 
      removeOnComplete: true, 
      removeOnFail: true 
    });
    
    console.log('✅ Enqueued job', job.id, 'with name "foo.bar"');
    console.log('👀 Check worker logs for rejection message');
    console.log('   Expected: "Unknown event type in critical_payments queue: foo.bar. Expected escrow.*_requested or payment.*"');
    
    await connection.quit();
    console.log('EVIL_B_PASS');
    process.exit(0);
  } catch (e) {
    console.error('❌ Error:', e.message);
    console.log('EVIL_B_FAIL');
    process.exit(1);
  }
})();
