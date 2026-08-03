# Backend Changes Log

## August 2-3, 2026

## Overview

This update focused on improving local backend setup, resolving service conflicts, fixing missing environment configuration, and ensuring database migrations run automatically during startup. Please note that I'm using linux debian distro for my testing.

---

## Environment Changes

### Added Environment Variables

Added the following variables to `.env`:

```env
TASK_LOCATION_ENCRYPTION_KEY=
WORKER_PORT=
```

---

### TASK_LOCATION_ENCRYPTION_KEY

This variable is required for task location encryption.

Generate a valid key using:

```bash
openssl rand -base64 32
```

Add the generated value to `.env`:

```env
TASK_LOCATION_ENCRYPTION_KEY=<generated-key>
```

---

### WORKER_PORT

Previously, `workers.ts` was using the same port as `server.ts`.

This caused conflicts when attempting to run both services simultaneously.

The worker runtime was updated to use a separate port.

Recommended local configuration:

```env
SERVER_PORT=5000
WORKER_PORT=5001
```

The services now run independently:

- API Server → `localhost:5000`
- Worker Runtime → `localhost:5001`

---

## Redis Setup

Redis is currently running locally through Docker.

### Start Redis

First-time setup:

```bash
docker run --name hustlexp-redis -p 6379:6379 -d redis
```

If the container already exists:

```bash
docker start hustlexp-redis
```

Verify Redis:

```bash
docker exec -it hustlexp-redis redis-cli ping
```

Expected output:

```
PONG
```

---

## PostgreSQL Setup

PostgreSQL must be running before starting backend workers.

Start PostgreSQL:

```bash
sudo systemctl start postgresql
```

Verify:

```bash
pg_isready
```

Expected output:

```
/var/run/postgresql:5432 - accepting connections
```

---

# Migration Runner Fix

## Problem

The backend already contained an automated migration runner:

```
backend/src/jobs/engine-automation-migration.ts
```

The file contained:

```ts
runEngineAutomationMigration()
```

However, the function was not called during worker startup.

Because of this, a fresh database would not automatically receive the required migrations.

This caused worker jobs to fail with errors such as:

```
relation "task_safety_checkins" does not exist
column "contract_version" does not exist
```

Previously, migrations had to be applied manually.

---

## Solution

Updated:

```
backend/src/jobs/workers.ts
```

Added:

```ts
await runEngineAutomationMigration();
```

to the worker startup process.

The startup sequence is now:

```
Start Worker Runtime
        |
        v
Run Database Migrations
        |
        v
Register BullMQ Workers
        |
        v
Register Scheduled Jobs
        |
        v
Start Outbox Worker
```

Fresh database setups will now automatically apply required migrations before workers begin processing jobs.

---

# Testing

The migration flow was tested using a clean database.

Steps performed:

1. Removed existing database:

```sql
DROP DATABASE my_db;
```

2. Created a fresh database:

```sql
CREATE DATABASE my_db;
```

3. Started worker runtime:

```bash
npx tsx --env-file-if-exists=.env backend/src/jobs/workers.ts
```

Result:

- Migration runner executed successfully.
- Required tables were created automatically.
- Worker runtime started successfully.

---

**Updated:** August 3, 2026  
**Author:** Martin