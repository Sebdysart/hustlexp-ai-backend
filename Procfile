# HustleXP Production Procfile
# CONSTITUTIONAL: Production deployment configuration
# DO NOT use tsx in production - always use compiled JavaScript

# Web server - compiled binary
web: node dist/backend/src/server.js

# Background job workers - separate process
worker: node dist/backend/src/jobs/workers.js

# Release phase - READ-ONLY schema validation before deploying new code.
# MUST NOT run anything destructive here. `db:migrate` was removed because it
# runs `DROP SCHEMA public CASCADE` (full data wipe). Schema changes are applied
# out-of-band via the reviewed alignment process — never in the deploy release phase.
release: npm run db:validate
