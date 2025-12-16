
import { FastifyInstance } from 'fastify';
import { sql, isDatabaseAvailable } from '../db/index.js';

export default async function debugRoutes(fastify: FastifyInstance) {

  // GET /api/test-db
  fastify.get('/test-db', async (request, reply) => {
    if (!isDatabaseAvailable() || !sql) {
      return reply.status(500).send({
        success: false,
        error: 'Database not configured (DATABASE_URL missing)'
      });
    }

    try {
      // 1. Simple Select
      const nowResult = await sql`SELECT NOW() as time`;
      const serverTime = nowResult[0].time;

      // 2. Test Table Insert (Temporary)
      // We create a temp table execution-local to verify write permissions
      // Note: CREATE TEMP TABLE might not work in serverless/pooled envs easily across requests,
      // but for a single request it might.
      // Safer: Just insert into users with a random ID and rollback?
      // Or just trust SELECT NOW() proves connection + READ.
      // To prove WRITE, let's try to update a non-existent row or something safe.
      // Actually, let's just create a dummy table if not exists.

      // Checking if we can create a table (requires admin privileges typically)
      // Let's stick to just SELECT NOW() for basic connectivity
      // AND a specific check on the 'users' table to verify schema existence.

      const usersCount = await sql`SELECT count(*) as count FROM users`;

      return {
        success: true,
        message: 'Database connection verified',
        timestamp: serverTime,
        usersCount: usersCount[0].count,
        mode: 'real'
      };

    } catch (error: any) {
      request.log.error({ error }, 'DB Test Failed');
      return reply.status(500).send({
        success: false,
        error: 'Database query failed',
        details: error.message
      });
    }
  });
}
