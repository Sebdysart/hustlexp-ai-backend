# HustleXP Production Procfile
# CONSTITUTIONAL: Production deployment configuration
# DO NOT use tsx in production - always use compiled JavaScript

# Web server - compiled binary
web: npm start

# Background job workers - separate process
worker: npm run start:workers

# Release phase is read-only. Web and worker startup apply the reviewed,
# idempotent runtime migration manifest before accepting work.
release: npm run db:validate
