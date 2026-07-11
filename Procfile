# HustleXP Production Procfile
# CONSTITUTIONAL: Production deployment configuration
# DO NOT use tsx in production - always use compiled JavaScript

# Web server - compiled binary
web: npm start

# Background job workers - separate process
worker: npm run start:workers

# Release phase - READ-ONLY schema validation before deploying new code.
# MUST NOT run anything destructive here. `db:migrate` was removed because it
# runs `DROP SCHEMA public CASCADE` (full data wipe). Schema changes are applied
# out-of-band via the reviewed alignment process — never in the deploy release phase.
release: npm run db:validate
