# HustleXP Production Procfile
# CONSTITUTIONAL: Production deployment configuration
# DO NOT use tsx in production - always use compiled JavaScript

# Web server - compiled binary
web: npm start

# Background job workers - separate process
worker: npm run start:workers

# Release phase is read-only. Web and worker startup only attest exact migration
# evidence; schema writes require the separately approved migration service.
release: npm run db:validate
