# System Integrity Tests

These tests verify end-to-end authority enforcement and schema alignment.

## Database Requirements

**CRITICAL:** These tests **must** run against **local Postgres** (not Neon serverless).

### Why Local Postgres?

Neon serverless uses driver-level query plan caching that interferes with schema-mutation tests. The integrity tests require deterministic query planning when schema changes during test execution.

### Setup

### Option 1: Docker (Recommended)

1. **Start Docker Desktop** (if not already running)

2. **Start local Postgres container:**
   ```bash
   docker rm -f hustlexp-test-db || true
   
   docker run -d \
     --name hustlexp-test-db \
     -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=hustlexp_test \
     -p 5432:5432 \
     postgres:15
   
   # Wait for Postgres to be ready
   sleep 3
   docker exec hustlexp-test-db pg_isready -U postgres
   ```

### Option 2: Existing Local Postgres

If you have Postgres already running locally:

1. **Create test database:**
   ```bash
   createdb hustlexp_test
   ```

2. **Use your existing connection string:**
   ```bash
   export LOCAL_TEST_DB_URL="postgresql://your_user:your_password@localhost:5432/hustlexp_test"
   ```

2. **Set LOCAL_TEST_DB_URL:**
   ```bash
   export LOCAL_TEST_DB_URL="postgresql://postgres:postgres@localhost:5432/hustlexp_test"
   ```

3. **Apply schema:**
   ```bash
   # Run migrations against test DB
   DATABASE_URL=$LOCAL_TEST_DB_URL npm run db:migrate
   ```

4. **Run tests:**
   ```bash
   LOCAL_TEST_DB_URL=$LOCAL_TEST_DB_URL npm run test -- backend/tests/system/
   ```

## Architecture

- **Production/Runtime:** Uses Neon serverless (via `backend/src/db.ts`)
- **Integrity Tests:** Uses local Postgres (via `backend/tests/system/test-db.ts`)

This cleanly separates execution correctness from deployment substrate quirks.
