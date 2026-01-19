# System Integrity Test Setup

## Prerequisites

**Docker must be running** OR you must have a local Postgres instance.

## Quick Setup (Docker)

```bash
# 1. Start Postgres container
docker rm -f hustlexp-test-db || true
docker run -d \
  --name hustlexp-test-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=hustlexp_test \
  -p 5432:5432 \
  postgres:15

# 2. Wait for Postgres to be ready
sleep 3
docker exec hustlexp-test-db pg_isready -U postgres

# 3. Apply schema migrations
export LOCAL_TEST_DB_URL="postgresql://postgres:postgres@localhost:5432/hustlexp_test"
export DATABASE_URL="$LOCAL_TEST_DB_URL"
npm run db:migrate

# 4. Verify schema
docker exec hustlexp-test-db psql -U postgres -d hustlexp_test -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'worker_id';"

# 5. Run integrity tests
LOCAL_TEST_DB_URL="postgresql://postgres:postgres@localhost:5432/hustlexp_test" \
npm run test -- backend/tests/system/alpha_authority_integrity.test.ts
```

## Troubleshooting

**Error: "Docker daemon not running"**
- Start Docker Desktop
- Wait for it to fully start
- Retry the docker commands

**Error: "role postgres does not exist"**
- Check your connection string matches the Postgres setup
- For Docker: use `postgres:postgres@localhost:5432`
- For local Postgres: use your actual username/password

**Error: "database does not exist"**
- Run migrations first: `npm run db:migrate`
- Or create manually: `createdb hustlexp_test`
