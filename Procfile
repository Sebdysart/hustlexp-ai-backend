# HustleXP Production Procfile
# CONSTITUTIONAL: Production deployment configuration
# DO NOT use tsx in production - always use compiled JavaScript

# Web server - compiled binary
web: node dist/backend/src/server.js

# Background job workers - separate process
worker: node dist/backend/src/jobs/workers.js

# Release phase - run database migrations before deploying new code
release: npm run db:migrate
