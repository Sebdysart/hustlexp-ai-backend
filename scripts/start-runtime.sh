#!/bin/sh
set -eu

# Railway's pre-deploy container needs the migrator connection. The long-lived
# runtime must never inherit it. Docker invokes this script directly as PID 1 so
# there is no parent npm or shell process retaining the secret environment.
unset MIGRATION_DATABASE_URL

if [ "${SERVICE_ROLE:-}" = "worker" ]; then
  exec node dist/backend/src/jobs/workers.js
fi

exec node dist/backend/src/server.js
